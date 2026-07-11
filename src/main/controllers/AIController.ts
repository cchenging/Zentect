// 📁 覆盖文件: src/main/controllers/AIController.ts
import { IpcRouter } from '../core/IpcRouter';
import { AIService } from '../services/AIService';
import { IPC_CHANNELS } from '../../shared/utils/IpcConstants';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import { AIEngine } from '../engine/AIEngine';
import { PathManager } from '../utils/pathManager';
import * as path from 'path';
import * as fs from 'fs';

export class AIController {
  private aiService = new AIService();

  public register() {
    // 💥 1. 注册核心管线执行接口
    IpcRouter.handle(IPC_CHANNELS.PIPELINE_RUN, async (event, payload) => {
      return await this.aiService.executePipeline(payload, event.sender);
    });

    // 💥 2. 注册管线中止接口
    IpcRouter.handle(IPC_CHANNELS.PIPELINE_STOP, async () => {
      return this.aiService.abortPipeline();
    });

    // 💥 3. 注册节点产出物获取接口
    IpcRouter.handle(IPC_CHANNELS.GET_NODE_OUTPUT, async (_, { projectId, nodeId, type }) => {
      return await this.aiService.getNodeOutput(projectId, nodeId, type);
    });

    // 🌟 修复：移除多余的 try-catch 套娃
    IpcRouter.handle(IPC_CHANNELS.SYSTEM_TEST_LLM, async (_, payload) => {
      return await this.aiService.testLLM(payload.provider, payload.apiKey, payload.baseURL);
    });

    IpcRouter.handle(IPC_CHANNELS.AI_GENERATE_TTS, async (_, text, roleId, projectId) => {
      return await this.aiService.runSingleTTS(projectId || 'default', { text, roleId, provider: 'edge' });
    });

    // 💥 修复核心：统一接管前端发来的真实测试通道
    IpcRouter.handle(IPC_CHANNELS.AI_TEST_NETWORK, async (_, type, config) => {
      return await this.aiService.testNetwork(type, config);
    });

    // 修复 TTS 连通性测试通道
    IpcRouter.handle(IPC_CHANNELS.AI_TEST_TTS, async (_, provider) => {
      return await this.aiService.testTTS(provider);
    });

    IpcRouter.handle(IPC_CHANNELS.AI_RUN_SINGLE_TTS, async (_, projectId, shot) => {
      return await this.aiService.runSingleTTS(projectId, shot);
    });

    IpcRouter.handle(IPC_CHANNELS.AI_RUN_GLOBAL_TTS, async (_, projectId, shots) => {
      return await this.aiService.runGlobalTTS(projectId, shots);
    });

    IpcRouter.handle(IPC_CHANNELS.AI_GENERATE_SCRIPT, async (event, payload) => {
      AppLogger.info(LOG_TAGS.AI_AGENT, `开始生成剧本: ${payload.projectId}`);
      return await this.aiService.generateScript(payload, event.sender);
    });

    IpcRouter.handle(IPC_CHANNELS.AI_VISION_SINGLE, async (_, data) => {
      return await this.aiService.visionSingle(data);
    });

    IpcRouter.handle(IPC_CHANNELS.AI_EMOTION_SINGLE, async (_, data) => {
      return await this.aiService.emotionSingle(data);
    });

    IpcRouter.handle(IPC_CHANNELS.AI_SEARCH_SEMANTICS, async (_, mediaId, query) => {
      return await this.aiService.searchSemantics(mediaId, query);
    });

    IpcRouter.handle(IPC_CHANNELS.AI_CHAT_REQUEST, async (_, payload) => {
      return await this.aiService.chatRequest(payload.prompt, payload.context);
    });

    IpcRouter.handle(IPC_CHANNELS.AGENT_GET_HISTORY, async (_, projectId) => {
      return await this.aiService.getHistory(projectId);
    });

    IpcRouter.handle(IPC_CHANNELS.AGENT_MARK_EXECUTED, async (_, msgId) => {
      return await this.aiService.markExecuted(msgId);
    });

    IpcRouter.handle(IPC_CHANNELS.AI_SEARCH_BROLL, async (_, payload) => {
      return await this.aiService.searchBrollLocally(payload);
    });

    IpcRouter.handle(IPC_CHANNELS.AI_ISOLATE_VOCALS, async (_, projectId, shotId) => {
      return await this.aiService.isolateVocalsLocally(projectId, shotId);
    });

    IpcRouter.handle(IPC_CHANNELS.AI_EXTRACT_FRAMES, async (_, mediaId, strategy = 'keyframe', fps = 1) => {
      return await this.aiService.extractFramesLocally(mediaId, strategy, fps);
    });

    IpcRouter.handle(IPC_CHANNELS.AGENT_CHAT_INVOKE, async (event, payload) => {
      try {
        AppLogger.info(LOG_TAGS.AI_ENGINE, `Agent 收到对话请求："${payload.prompt}"`);
        return await this.aiService.agentStreamChat(
          event.sender, payload.projectId, payload.prompt,
          payload.context, payload.history || [], payload.provider
        );
      } catch (e: any) {
        AppLogger.error(LOG_TAGS.AI_ENGINE, "Agent 流式对话崩溃", e);
        return { success: false, error: e.message };
      }
    });

    IpcRouter.handle(IPC_CHANNELS.AI_CHAT, async (event, payload) => {
      AppLogger.info(LOG_TAGS.AI_AGENT, `收到聊天请求: ${payload.projectId}`);
      return await this.aiService.handleChat(payload, event.sender);
    });

    IpcRouter.handle(IPC_CHANNELS.AI_GET_HISTORY, async (_, projectId) => {
      return await this.aiService.getChatHistory(projectId);
    });

    // 🔊 语音克隆
    IpcRouter.handle('voice:clone', async (_, payload: { audioData: number[]; name: string; text: string; language: string }) => {
      try {
        const fs = await import('fs');
        const path = await import('path');
        const { PathManager } = await import('../utils/pathManager');
        const crypto = await import('crypto');

        const clonesDir = path.join(PathManager.getUserDataPath(), 'cloned_voices');
        const cloneId = `custom-clone-${crypto.randomBytes(4).toString('hex')}`;
        const cloneDir = path.join(clonesDir, cloneId);
        fs.mkdirSync(cloneDir, { recursive: true });

        const audioPath = path.join(cloneDir, 'sample.wav');
        fs.writeFileSync(audioPath, Buffer.from(payload.audioData));

        const res = await fetch('http://127.0.0.1:9881/clone', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audio_path: audioPath,
            name: payload.name,
            text: payload.text,
            language: payload.language
          })
        });
        return await res.json();
      } catch (e: any) {
        return { code: -1, detail: e.message };
      }
    });

    // 🔊 音色试听
    IpcRouter.handle(IPC_CHANNELS.VOICE_PREVIEW, async (_, payload: { provider: string; voiceId?: string; text?: string }) => {
      const previewText = payload.text || '欢迎使用 Zentect 智能剪辑';
      const audioPath = await AIEngine.generateTTS(previewText,
        payload.provider as any, undefined, payload.voiceId);
      return { audioPath };
    });

    // 🔊 引擎音色列表
    const HARDCODED_VOICES: Record<string, any[]> = {
      edge: [
        { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓 (女)', lang: 'zh-CN' },
        { id: 'zh-CN-YunxiNeural', name: '云希 (男)', lang: 'zh-CN' },
        { id: 'zh-CN-XiaoyiNeural', name: '晓伊 (女)', lang: 'zh-CN' },
        { id: 'zh-CN-YunyangNeural', name: '云扬 (男)', lang: 'zh-CN' },
        { id: 'zh-CN-XiaochenNeural', name: '晓辰 (女)', lang: 'zh-CN' },
        { id: 'en-US-JennyNeural', name: 'Jenny (EN)', lang: 'en-US' },
      ],
      doubao: [
        { id: 'zh_female_meilinvyou_saturn_bigtts', name: '魅力女友 (女)', lang: 'zh' },
        { id: 'zh_male_shaonv_saturn_bigtts', name: '少年 (男)', lang: 'zh' },
      ],
      fish: [
        { id: 'reference', name: '参考音频克隆', lang: 'any' },
      ],
    };

    IpcRouter.handle(IPC_CHANNELS.VOICE_LIST_BY_ENGINE, async (_, engine: string) => {
      if (engine === 'moss') {
        try {
          const res = await fetch('http://127.0.0.1:9881/voices');
          const data = await res.json();
          return Object.entries(data.voices).map(([id, info]: [string, any]) => ({
            id,
            name: info.display_name || id,
            lang: info.group || '',
          }));
        } catch {
          return [];
        }
      }
      return HARDCODED_VOICES[engine] || [];
    });

    // 🔊 克隆音色列表
    IpcRouter.handle('voice:get-cloned-voices', async () => {
      try {
        const clonesDir = path.join(PathManager.getUserDataPath(), 'cloned_voices');
        if (!fs.existsSync(clonesDir)) return [];
        const dirs = fs.readdirSync(clonesDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => ({ id: d.name, name: d.name, lang: 'custom' }));
        return dirs;
      } catch {
        return [];
      }
    });
  }
}
