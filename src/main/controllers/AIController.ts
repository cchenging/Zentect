// 📁 覆盖文件: src/main/controllers/AIController.ts
import { IpcRouter } from '../core/IpcRouter';
import { AIService } from '../services/AIService';
import { IPC_CHANNELS } from '../../shared/utils/IpcConstants';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../shared/utils/LogConstants';
import { VisionExtractStrategy } from '../engine/strategies/VisionExtractStrategy';
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

    /** 画面描述：复用步骤1已有帧，直接 VLM 分析，不再重新抽帧 */
    IpcRouter.handle(IPC_CHANNELS.AI_VISION_EXTRACT, async (_, payload: { projectId: string; mediaPath: string; mediaId: string; framePaths?: string[] }) => {
      const { projectId, mediaPath, mediaId, framePaths } = payload;

      /** 将 magic:// 帧路径还原为物理绝对路径 */
      const projectDir = PathManager.getProjectDir(projectId);
      const dehydrate = (p: string): string => {
        if (!p.startsWith('magic://')) return p;
        const prefix = `magic://${projectId}/`;
        if (p.startsWith(prefix)) {
          const rel = p.replace(prefix, '');
          return path.isAbsolute(rel) ? rel : path.join(projectDir, rel);
        } else if (p.startsWith('magic://local/')) {
          return p.replace('magic://local/', '').replace(/\//g, '\\');
        }
        return path.join(projectDir, p.replace(/^magic:\/\/[^/]+\//, ''));
      };

      /** 获取可用的帧图片物理路径列表 */
      let physicalFrames: string[] = [];
      if (framePaths && framePaths.length > 0) {
        physicalFrames = framePaths.map(dehydrate).filter((p: string) => {
          try { return fs.existsSync(p); } catch { return false; }
        });
      }

      if (physicalFrames.length === 0) {
        throw new Error('画面描述失败：未找到已提取的关键帧，请先完成步骤1「素材分析」');
      }

      AppLogger.info(LOG_TAGS.AI_AGENT, `[画面描述] 复用步骤1已有帧 ${physicalFrames.length} 张，跳过 FFmpeg 抽帧`);

      /** 直接调用 VLM 分析已有帧图片 */
      const { LLMFactory } = await import('../engine/adapters/LLMFactory');
      const { adapter, modelName } = LLMFactory.createAdapter('visual');
      const model = modelName || 'qwen-vl-max';

      const BATCH_SIZE = 10;
      const allDescriptions: string[] = [];

      for (let batchStart = 0; batchStart < physicalFrames.length; batchStart += BATCH_SIZE) {
        const batchFrames = physicalFrames.slice(batchStart, batchStart + BATCH_SIZE);
        const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(physicalFrames.length / BATCH_SIZE);

        AppLogger.info(LOG_TAGS.AI_AGENT, `[画面描述] VLM 批次 ${batchNum}/${totalBatches}，帧 ${batchStart + 1}-${batchStart + batchFrames.length}`);

        const imageContents = batchFrames.map(framePath => {
          const base64 = fs.readFileSync(framePath, 'base64');
          return { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } };
        });

        const messages = [
          { role: 'system', content: '你是一个专业的视频画面解析引擎。请严格按照时间顺序，详细描述这些连续画面中发生的动作、人物神态、环境和景别。每帧描述单独一行，以序号开头。' },
          { role: 'user', content: [{ type: 'text', text: `请解析以下视频关键帧（第${batchStart + 1}-${batchStart + batchFrames.length}帧），并生成场景描述：` }, ...imageContents] }
        ];

        const rawResult = await adapter.chat(messages, model, 0.2);
        const resultText = typeof rawResult === 'string' ? rawResult : (rawResult as any).text || '';
        allDescriptions.push(resultText);
      }

      const sceneDescriptions = allDescriptions.join('\n');
      AppLogger.info(LOG_TAGS.AI_AGENT, `[画面描述] 完成，描述长度: ${sceneDescriptions.length}，帧数: ${physicalFrames.length}`);

      return {
        framesCount: physicalFrames.length,
        sceneDescriptions,
        framePaths: framePaths || physicalFrames,
      };
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
  }
}
