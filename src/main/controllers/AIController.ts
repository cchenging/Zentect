// 📁 覆盖文件: src/main/controllers/AIController.ts
import { IpcRouter } from '../core/IpcRouter';
import { AIService } from '../services/AIService';
import { IPC_CHANNELS } from '../../modules/infra/ipc/IpcConstants';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import { ttsEngine } from '../engine/TTSEngine';

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

    // 🌟 修复：优先拿 payload 里的 model（或 models[0]）传入，真实测"用户选中的模型"，不再硬编码无关小模型
    IpcRouter.handle(IPC_CHANNELS.SYSTEM_TEST_LLM, async (_, payload) => {
      const model: string | undefined = payload?.model || (Array.isArray(payload?.models) && payload.models[0]) || undefined;
      return await this.aiService.testLLM(payload.provider, payload.apiKey, payload.baseURL, model);
    });

    IpcRouter.handle(IPC_CHANNELS.AI_GENERATE_TTS, async (_, text, roleId, projectId) => {
      return await this.aiService.runSingleTTS(projectId || 'default', { text, roleId, provider: 'edge' });
    });

    // 💥 修复核心：统一接管前端发来的真实测试通道
    IpcRouter.handle(IPC_CHANNELS.AI_TEST_NETWORK, async (_, type, config) => {
      return await this.aiService.testNetwork(type, config);
    });

    // 拉取账户可用模型列表（OpenAI 兼容 /models 接口）
    IpcRouter.handle(IPC_CHANNELS.AI_FETCH_MODELS, async (_, config) => {
      return await this.aiService.fetchModels(config);
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

    // 🎵 AI 深度 BGM 推荐：依据解说文案语义调用 LLM 生成个性化选曲
    IpcRouter.handle(IPC_CHANNELS.AI_BGM_RECOMMEND, async (_, payload) => {
      return await this.aiService.recommendBgm(payload);
    });

    // 🎵 P1 一键应用：下载曲库曲目到本地缓存
    IpcRouter.handle(IPC_CHANNELS.AI_BGM_DOWNLOAD, async (_, payload) => {
      return await this.aiService.downloadBgm(payload);
    });

    // 🎵 本地 BGM 曲库全量列表（按 tone 分组，供前端分类分页自选）
    IpcRouter.handle(IPC_CHANNELS.AI_BGM_LOCAL_LIST, async () => {
      return await this.aiService.listLocalBgm();
    });

    IpcRouter.handle(IPC_CHANNELS.AI_VISION_SINGLE, async (_, data) => {
      return await this.aiService.visionSingle(data);
    });

    // Python 依赖检查：返回 { deps, python_executable } 或 null（服务离线）
    IpcRouter.handle(IPC_CHANNELS.AI_CHECK_DEPS, async () => {
      return await this.aiService.checkDeps();
    });

    IpcRouter.handle(IPC_CHANNELS.AI_EMOTION_SINGLE, async (_, data) => {
      return await this.aiService.emotionSingle(data);
    });

    IpcRouter.handle(IPC_CHANNELS.AI_SEARCH_SEMANTICS, async (_, mediaId, query) => {
      return await this.aiService.searchSemantics(mediaId, query);
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

    IpcRouter.handle(IPC_CHANNELS.AI_EXTRACT_FRAMES, async (_, mediaId, strategy = 'keyframe', fps = 1) => {
      return await this.aiService.extractFramesLocally(mediaId, strategy, fps);
    });

    IpcRouter.handle(IPC_CHANNELS.AGENT_CHAT_INVOKE, async (event, payload) => {
      try {
        AppLogger.info(LOG_TAGS.AI_ENGINE, `Agent 收到对话请求："${payload.prompt}"`);
        return await this.aiService.agentStreamChat(
          event.sender, payload.projectId, payload.prompt,
          payload.context, payload.history || []
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

    // 🔊 音色试听
    IpcRouter.handle(IPC_CHANNELS.VOICE_PREVIEW, async (_, payload: { provider: string; voiceId?: string; text?: string; rate?: number }) => {
      const previewText = payload.text || '欢迎使用 Zentect 智能剪辑';
      const audioPath = await ttsEngine.generateTTS(previewText,
        payload.provider as any, undefined, payload.voiceId, payload.rate);
      return { audioPath };
    });

    // 🔊 引擎音色列表
    // 注意：VOICE_LIST_BY_ENGINE 实际由 EngineController.getVoicesForEngine 处理（后注册胜出）
    // 此处不再重复注册，避免代码歧义。AIController 仅保留 VOICE_PREVIEW 处理试听。
  }
}
