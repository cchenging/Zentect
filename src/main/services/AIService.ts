// &#x1F4C1; 新建文件: src/main/services/AIService.ts
import { AIEngine } from '../engine/AIEngine';
import { AIDaemon } from '../core/AIDaemon';
import { ChatHistoryRepository } from '../database/repositories/ChatHistoryRepository';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../shared/utils/LogConstants';
import { IPC_CHANNELS } from '../../shared/utils/IpcConstants';
import { LLMFactory } from '../engine/adapters/LLMFactory';
import { MediaRepository } from '../database/repositories/MediaRepository';
import { PipelinePayload } from '../../shared/types';
import { PipelineEngine } from '../engine/PipelineEngine';
import { AppError, ErrorCode } from '../../shared/utils/AppError';
import { MultiChannelPipeline } from '../core/MultiChannelPipeline';
import { ProviderManager } from '../engine/config/ProviderManager';
import * as fs from 'fs';
import * as path from 'path';
import { PathManager } from '../utils/pathManager';

export class AIService {
  private pipelineEngine: PipelineEngine;

  constructor() {
    this.pipelineEngine = new PipelineEngine();
  }

  public async handleChat(payload: any, sender: Electron.WebContents) {
    const { projectId, text, context } = payload;

    await this.saveHistory(projectId, 'user', text);

    try {
      const messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: '你是一个AI视频剪辑助手，回答用户关于视频剪辑的问题。' },
        ...(context ? [{ role: 'user', content: `上下文: ${JSON.stringify(context)}` }] : []),
        { role: 'user', content: text }
      ];

      // 💥 OPT-5: 使用 MultiChannelPipeline 包裹 LLM 调用，主通道失败自动切换备用通道
      const reply = await MultiChannelPipeline.executeWithFailover(
        // 主通道
        () => {
          const primaryConfig = ProviderManager.getLLMConfig('chat');
          const adapter = LLMFactory.createFromConfig(primaryConfig);
          return adapter.chat(messages, primaryConfig.model, primaryConfig.temperature);
        },
        // 备用通道（降级到 proxy 通道）
        () => {
          const fallbackConfig = ProviderManager.getLLMConfig('chat', 'proxy');
          const adapter = LLMFactory.createFromConfig(fallbackConfig);
          return adapter.chat(messages, fallbackConfig.model, fallbackConfig.temperature);
        }
      );

      await this.saveHistory(projectId, 'assistant', reply.text || '');
      if (sender && !sender.isDestroyed()) {
        sender.send(IPC_CHANNELS.AI_CHAT_STREAM, { chunk: reply });
      }
      return { text: reply };
    } catch (error: any) {
      AppLogger.error(LOG_TAGS.AI_AGENT, '聊天失败', error);
      throw error;
    }
  }

  public async generateScript(payload: any, sender: Electron.WebContents) {
    const { context } = payload;
    try {
      const systemPrompt = '你是一个短视频剧本专家。请根据用户需求生成JSON格式的分镜脚本数组。';
      const messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: systemPrompt },
        ...(context ? [{ role: 'user', content: `参考信息: ${JSON.stringify(context)}` }] : []),
        { role: 'user', content: payload.prompt || '请生成一个15秒短视频剧本' }
      ];

      // 💥 OPT-5: 使用 MultiChannelPipeline 包裹 LLM 调用
      const script = await MultiChannelPipeline.executeWithFailover(
        () => {
          const primaryConfig = ProviderManager.getLLMConfig('script');
          const adapter = LLMFactory.createFromConfig(primaryConfig);
          return adapter.chat(messages, primaryConfig.model, primaryConfig.temperature);
        },
        () => {
          const fallbackConfig = ProviderManager.getLLMConfig('script', 'proxy');
          const adapter = LLMFactory.createFromConfig(fallbackConfig);
          return adapter.chat(messages, fallbackConfig.model, fallbackConfig.temperature);
        }
      );

      if (sender && !sender.isDestroyed()) {
        sender.send(IPC_CHANNELS.AI_SCRIPT_PROGRESS, { progress: 100 });
      }
      return { text: script };
    } catch (error: any) {
      AppLogger.error(LOG_TAGS.AI_AGENT, '剧本生成失败', error);
      throw error;
    }
  }

  public async getChatHistory(_projectId: string) {
    return await new ChatHistoryRepository().getHistory(_projectId);
  }

  public async executePipeline(payload: PipelinePayload, sender: Electron.WebContents) {
    return await this.pipelineEngine.execute(payload, sender);
  }

  public abortPipeline() {
    this.pipelineEngine.abort();
    return { success: true, message: '已发送中止信号' };
  }

  public async probePipelineCache(payload: any) {
    return await this.pipelineEngine.probeCache(payload);
  }

  public async getNodeOutput(projectId: string, nodeId: string, type: string) {
    if (!projectId || !nodeId) throw new Error("缺少必要参数");

    /** 统一走 PathManager 标准路径，确保目录自动创建和路径一致性 */
    const outputDir = PathManager.getNodeBaseDir(projectId, nodeId, (type as 'frames' | 'audio' | 'whisper') || 'frames');

    if (!fs.existsSync(outputDir)) return [];

    return fs.readdirSync(outputDir)
      .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      .map(f => path.join(outputDir, f));
  }

  public async testLLM(provider: string, apiKey: string, baseURL?: string) {
    if (!apiKey) throw new Error("API Key 不能为空，请先填写");

    const adapter = LLMFactory.create(provider, apiKey, baseURL);
    await adapter.testConnection();
    return true;
  }

  public async testNetwork(type: string, config: any) {
    if (type === 'openai_like') {
      if (!config.apiKey) throw new Error("API Key 不能为空，请先填写");
      const adapter = LLMFactory.create(config.provider, config.apiKey, config.baseURL);
      await adapter.testConnection();
      return '连接成功，通道握手正常';
    }

    return await AIEngine.testNetwork(type as 'doubao_tts' | 'openai_like', config);
  }

  public async testTTS(provider: string) {
    try {
      await AIEngine.generateTTS('测试语音', provider as 'doubao' | 'fish' | 'edge' | 'sovits' | 'moss');
      return 'success';
    } catch (e: any) {
      return `连接失败: ${e.message}`;
    }
  }

  public async runSingleTTS(_projectId: string, shot: any) {
    const provider = shot.provider || 'edge';
    return await AIEngine.generateTTS(shot.text, provider as 'doubao' | 'fish' | 'edge' | 'sovits' | 'moss');
  }

  public async runGlobalTTS(_projectId: string, shots: any[]) {
    const results: Array<{ shot: any; audioPath?: any; error?: string }> = [];
    for (const shot of shots) {
      try {
        const provider = shot.provider || shot.voiceId || 'edge';
        const result = await AIEngine.generateTTS(shot.text || '', provider as 'doubao' | 'fish' | 'edge' | 'sovits' | 'moss');
        results.push({ shot, audioPath: result });
      } catch (e: any) {
        AppLogger.warn(LOG_TAGS.AI_AGENT, `TTS failed for shot ${shot.id}`, e);
        results.push({ shot, error: e.message });
      }
    }
    return results;
  }

  public async generateAiScript(data: any) {
    try {
      const llm = LLMFactory.createFromConfig({ provider: data.llmEngine || 'deepseek-chat', apiKey: '', model: data.llmEngine || 'deepseek-chat', temperature: 0.7 } as any);
      const messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: '你是一个短视频剧本生成专家。请生成JSON格式的分镜脚本。' },
        { role: 'user', content: `主题: ${data.theme || '通用短视频'}\n风格: ${data.scriptStyle || '专业'}\n时长: ${data.targetDuration || '15'}秒` }
      ];
      const script = await llm.chat(messages, 'deepseek-chat', 0.7);
      return { success: true, data: script };
    } catch (e: any) {
      AppLogger.error(LOG_TAGS.AI_AGENT, 'AI剧本生成失败', e);
      return { success: false, error: e.message };
    }
  }

  public async visionSingle(data: any) {
    return await AIDaemon.getInstance().post('/api/vision', data);
  }

  public async emotionSingle(data: any) {
    return await AIDaemon.getInstance().post('/api/emotion', data);
  }

  public async searchSemantics(mediaId: string, query: string) {
    const res = await AIDaemon.getInstance().post('/api/search_semantics', { media_id: mediaId, query: query, top_k: 20 });
    if (!res.success) throw new Error(res.error || '检索引擎返回异常状态');
    return res.results;
  }

  public async chatRequest(prompt: string, context: any) {
    const response = await AIEngine.chatRequest(prompt, context);
    return { success: true, text: response };
  }

  public async getHistory(projectId: string) {
    return new ChatHistoryRepository().getHistory(projectId);
  }

  public async markExecuted(msgId: string) {
    new ChatHistoryRepository().markExecuted(msgId);
    return { success: true };
  }

  public async searchBrollLocally(payload: any) {
    return await AIEngine.searchBrollLocally(payload);
  }

  public async isolateVocalsLocally(projectId: string, shotId: string) {
    return await AIEngine.isolateVocalsLocally(projectId, shotId);
  }

  public async extractFramesLocally(mediaId: string, strategy: 'keyframe' | 'fps' | 'uniform' = 'keyframe', fps: number = 1) {
    const mediaRepo = new MediaRepository();
    const media = await mediaRepo.findById(mediaId);
    if (!media?.filePath) throw new AppError(ErrorCode.FS_FILE_NOT_FOUND, `媒体文件 ${mediaId} 不存在`);
    return await AIEngine.extractFramesLocally(media.filePath, PathManager.getProjectDir(mediaId), strategy, fps);
  }

  public async agentStreamChat(sender: Electron.WebContents, projectId: string, prompt: string, context: any, history: Array<{ role: string; content: string }>, provider?: string) {
    await AIEngine.agentStreamChat(sender, projectId, prompt, context, history, provider);
    return { success: true };
  }

  private async saveHistory(projectId: string, role: 'user' | 'assistant', content: string) {
    const repo = new ChatHistoryRepository();
    await repo.saveMessage(projectId, role, content);
  }
}
