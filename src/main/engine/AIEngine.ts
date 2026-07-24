// 📁 路径：src/main/engine/AIEngine.ts

import { WebContents } from 'electron';
import { NetworkPipeline } from '../core/NetworkPipeline';
import { IPC_CHANNELS } from '../../modules/infra/ipc/IpcConstants';
import { PromptBuilder } from './prompts/PromptBuilder';
import { LLMFactory } from './adapters/LLMFactory'; 
import { ProviderManager } from './config/ProviderManager'; // 💥 唯一合法的配置出处
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import fs from 'fs';
import { ChatHistoryRepository } from '../database/repositories/ChatHistoryRepository';
import { MediaRepository } from '../database/repositories/MediaRepository';
import { healthCheckService } from './HealthCheckService';

export type AITaskType = 'visual' | 'script' | 'translate' | 'helper';

export interface ServiceCheck {
  name: string;
  available: boolean;
  type: 'local' | 'cloud';
  hint: string;
}

export class AIEngine {

  // ---------------------------------------------------------------------------
  // V1.2: 内容安全拦截 — HTTP 状态码 → 用户友好中文提示
  // ---------------------------------------------------------------------------
  /** 将 LLM 请求失败的原始错误翻译为用户可理解的提示 */
  private static translateHttpError(rawError: any): string {
    return healthCheckService.translateHttpError(rawError);
  }

  // ---------------------------------------------------------------------------
  // 🧠 1. 基础对话推流 (纯净调用 Adapter)
  // ---------------------------------------------------------------------------
  public static async streamChat(webContents: WebContents, taskType: AITaskType, systemPrompt: string, userMessage: string, replyChannel: string) {
    try {
      // 👑 严格执宪：拿配置 -> 找工厂 -> 让适配器去干活
      const config = ProviderManager.getLLMConfig(taskType);
      const adapter = LLMFactory.createFromConfig(config);
      
      webContents.send(`${replyChannel}:start`, { model: config.model, task: taskType });
      
      const messages = [
        { role: 'system', content: systemPrompt }, 
        { role: 'user', content: userMessage }
      ];

      // 假设底层 Adapter 已实现 webContents 推流，否则也可在此调用 adapter.chat
      await adapter.streamChatToBrowser(webContents, messages, config.model, config.temperature, replyChannel);

    } catch (error: any) {
      const friendlyMsg = this.translateHttpError(error);
      AppLogger.error(LOG_TAGS.AI_ENGINE, `streamChat HTTP 错误: ${error.message}`);
      webContents.send(`${replyChannel}:error`, friendlyMsg);
    }
  }

  // ---------------------------------------------------------------------------
  // 🎬 2. 核心业务流水线 (纯净 Prompt 调用)
  // ---------------------------------------------------------------------------
  static async runAIRecreatePipeline(_projectId: string, _mediaPath: string, originalShots: any[], _mediaId: string, roles: any[], targetLanguage: string = 'zh-CN'): Promise<any[]> {
    const config = ProviderManager.getLLMConfig('script');
    const systemPrompt = PromptBuilder.buildScriptPrompt(targetLanguage);
    const multimodalContext = originalShots.map(s => ({ shotId: s.id, originalText: s.originalText || '', visionText: s.visionText || '' }));
    const userPrompt = (PromptBuilder as any).buildUserPrompt ? (PromptBuilder as any).buildUserPrompt(roles, multimodalContext) : JSON.stringify({ roles, context: multimodalContext });

    const adapter = LLMFactory.createFromConfig(config);
    const response = await adapter.chat([{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], config.model, config.temperature);
    
    if (!response.success) throw new Error(this.translateHttpError(new Error(response.error)));

    // 💥 Layer 4: 强制流经数据清洗防线，阻断脏资产向状态层渗透
    let aiSentences: any[] = [];
    try {
      aiSentences = NetworkPipeline.strictParseJson(response.text || '');
    } catch(e) {
      throw new Error('模型返回数据格式破坏！');
    }

    const finalShots: any[] = [];
    let idx = 0;
    aiSentences.forEach((item: any) => {
      const cleanPhrase = (item.aiText || '').trim();
      if (!cleanPhrase) return;
      const sourceShot = originalShots.find(s => s.id === item.sourceShotId) || originalShots[0];
      finalShots.push({ 
        id: `ai_shot_${Date.now()}_${idx++}`, mediaId: _mediaId, start: sourceShot?.start || 0, end: sourceShot ? sourceShot.start + 1.5 : 1.5, 
        aiText: cleanPhrase, coverPath: sourceShot?.coverPath || '', roleId: item.roleId || '' 
      });
    });
    return finalShots;
  }

  static async analyzeVision(imagePath: string): Promise<string> {
    const config = ProviderManager.getLLMConfig('visual');
    if (config.baseURL.includes('deepseek.com')) throw new Error('拦截：DeepSeek 暂不支持识图！');
    
    let cleanPath = imagePath.replace(/^file:\/{2,3}/, '');
    if (!fs.existsSync(cleanPath)) throw new Error(`找不到物理图片: ${cleanPath}`);
    
    const base64Image = fs.readFileSync(cleanPath).toString('base64');
    const dataUrl = `data:image/jpeg;base64,${base64Image}`;
    
    const systemPrompt = PromptBuilder.buildVisionPrompt(); // 统一交由 Builder

    const adapter = LLMFactory.createFromConfig(config);
    // 假设底层 adapter 支持 VLM 多模态
    const response = await adapter.chat([{ role: "user", content: [ { type: "text", text: systemPrompt }, { type: "image_url", image_url: { url: dataUrl } } ] }], config.model, config.temperature);
    
    return response.success ? (response.text || '') : `视觉分析失败: ${this.translateHttpError(new Error(response.error))}`;
  }

  // ---------------------------------------------------------------------------
  // 🤖 5. Agent 终极形态 (完美接住前端配置参数)
  // ---------------------------------------------------------------------------
  public static async agentStreamChat(webContents: WebContents, projectId: string, prompt: string, context: any, history: any[] = [], provider?: string) {
    const chatRepo = new ChatHistoryRepository();
    try {
      webContents.send(IPC_CHANNELS.AGENT_STREAM_START);
      try {
        chatRepo.saveMessage(projectId, 'user', prompt);
      } catch(e: any) {
        AppLogger.error(LOG_TAGS.AI_ENGINE, `写入用户对话历史失败: ${e.message}`);
      }

      const config = ProviderManager.getLLMConfig('helper', provider);
      
      // =====================================================================
      // 💥 宪法级重构：代码极致整洁。数据从 Repository 拿，文案找 Builder 组装！
      // =====================================================================
      const mediaRepo = new MediaRepository();
      const agentData = mediaRepo.getAgentContextData(projectId);
      
      // 生成纯净的、已注入所有上下文的 System Prompt
      const systemPrompt = PromptBuilder.buildAgentPrompt(context, agentData);
      // =====================================================================

      const adapter = LLMFactory.createFromConfig(config);

      const tools = [
        { type: "function", function: { name: "update_shot_text", description: "修改台词", parameters: { type: "object", properties: { shotId: { type: "string" }, newText: { type: "string" } }, required: ["shotId", "newText"] } } },
        { type: "function", function: { name: "delete_shot", description: "删除镜头", parameters: { type: "object", properties: { shotId: { type: "string" } }, required: ["shotId"] } } },
        { type: "function", function: { name: "search_broll", description: "搜索素材库", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
        { type: "function", function: { name: "isolate_vocals", description: "人声提取", parameters: { type: "object", properties: { shotId: { type: "string" } }, required: ["shotId"] } } },
        {
          type: "function",
          function: {
            name: "extract_video_frames",
            description: "视频抽帧工具。警告：当调用此工具时，你必须在你的文本回复中向用户解释这三种策略（keyframe 关键帧、uniform 均匀采样、fps 固定帧率）的区别，并提醒用户可以在界面生成的卡片上修改策略。",
            parameters: {
              type: "object",
              properties: {
                mediaId: { type: "string" },
                strategy: { type: "string", enum: ["keyframe", "fps", "uniform"], description: "抽帧物理策略" },
                fps: { type: "number", description: "仅当策略为 fps 时有效，表示每秒抽取几帧，默认为 1" }
              },
              required: ["mediaId", "strategy"]
            }
          }
        }
      ];

      const messages = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: prompt }
      ];

      const result = await adapter.streamChatToBrowser(webContents, messages, config.model, 0.5, IPC_CHANNELS.AGENT_STREAM_CHUNK, tools);

      if (result.toolCall) {
        webContents.send(IPC_CHANNELS.AGENT_TOOL_CALL, result.toolCall);
      }

      try {
        chatRepo.saveMessage(projectId, 'assistant', result.text, result.toolCall);
      } catch(e: any) {
        AppLogger.error(LOG_TAGS.AI_ENGINE, `写入Agent回复历史失败: ${e.message}`);
      }
      webContents.send(IPC_CHANNELS.AGENT_STREAM_DONE);

    } catch (error: any) {
      const friendlyMsg = this.translateHttpError(error);
      AppLogger.error(LOG_TAGS.AI_ENGINE, `Agent HTTP 异常`, error);
      webContents.send(IPC_CHANNELS.AGENT_STREAM_ERROR, friendlyMsg);
    }
  }
}