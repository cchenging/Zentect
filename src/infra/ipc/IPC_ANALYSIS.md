# Zentect IPC 通信模块 — 完整接口契约报告

> **生成日期**: 2026-07-03
> **分析范围**: `src/main/`, `src/renderer/`, `src/shared/`, `src/preload/`
> **用途**: Phase 1 Step 5 — IPC 通信模块迁移到 `src/infra/ipc/` 的前置分析

---

## 一、IPC 相关文件全景

### 1.1 核心基础设施（需迁移）

| 文件 | 路径 | 职责 |
|------|------|------|
| IpcRouter | `src/main/core/IpcRouter.ts` | 封装 `ipcMain.handle`，提供 `handle()` 和 `handleWithSchema()` 两个静态方法 |
| IpcConstants | `src/shared/utils/IpcConstants.ts` | 全站 IPC 频道常量单一真相源（~120+ 频道） |
| contracts/ipc | `src/shared/contracts/ipc.ts` | `IpcResponse<T>` 接口、`BASE_IPC_RESPONSE_SCHEMA` (Zod)、`IPC_ERROR_CODES` |
| contracts/registry | `src/shared/contracts/registry.ts` | `SCHEMA_REGISTRY`：9 个频道的 Zod Schema 注册表 |
| types/ipc | `src/shared/types/ipc.ts` | 简化版 `IpcResponse<T>` 接口（共 13 行，基本未被使用） |

### 1.2 Preload 桥接层

| 文件 | 路径 | 职责 |
|------|------|------|
| preload/index.ts | `src/preload/index.ts` | `contextBridge.exposeInMainWorld('api', api)`，暴露安全包装器 + 域 API |
| preload/index.d.ts | `src/preload/index.d.ts` | `StrictlyTypedIpcRenderer` 泛型约束接口 |
| renderer env.d.ts | `src/renderer/src/env.d.ts` | `WindowApi` 接口和 `window.api` 全局类型声明 |

### 1.3 Main 进程控制器（10 个，注册 IPC handler）

| 控制器 | 路径 | 注册 handler 数 |
|--------|------|----------------|
| SystemController | `src/main/controllers/SystemController.ts` | 15 |
| SettingsController | `src/main/controllers/SettingsController.ts` | 6 |
| ProjectController | `src/main/controllers/ProjectController.ts` | 16 |
| MediaController | `src/main/controllers/MediaController.ts` | 6 |
| AIController | `src/main/controllers/AIController.ts` | 25 |
| EngineController | `src/main/controllers/EngineController.ts` | 25 |
| ExportController | `src/main/controllers/ExportController.ts` | 2 |
| UserController | `src/main/controllers/UserController.ts` | 9 |
| ModelController | `src/main/controllers/ModelController.ts` | 12 |
| ApiProfileController | `src/main/controllers/ApiProfileController.ts` | 9 |

**注册顺序**（`src/main/index.ts` L161-176）：

```
SystemController → ApiProfileController → ProjectController → MediaController
→ AIController → ExportController → EngineController → UserController
→ ModelController → SettingsController
```

### 1.4 Renderer 端消费者

| 文件 | 路径 | 用途 |
|------|------|------|
| API facade | `src/renderer/src/api/index.ts` | 按域封装的 API 调用对象，内部调用 `window.api.ipc.invoke` |
| IPCBridge | `src/renderer/src/core/IPCBridge.tsx` | React 组件，`useEffect` 中监听 4 个推送事件 |
| EventBridge | `src/renderer/src/bridge/EventBridge.ts` | 单例事件桥，预订阅 8 个频道 |
| useTaskStore | `src/renderer/src/store/useTaskStore.ts` | Zustand store，监听 task:progress |
| usePipeline | `src/renderer/src/store/hooks/usePipeline.ts` | 管线执行 hook |
| usePipelineExecutor | `src/renderer/src/pages/editor/hooks/usePipelineExecutor.ts` | 管线执行器 |
| useEditorLogic | `src/renderer/src/pages/editor/hooks/useEditorLogic.ts` | 编辑器逻辑 |
| usePipelineOrchestrator | `src/renderer/src/pages/editor/hooks/usePipelineOrchestrator.ts` | 管线编排 |
| useTaskProgress | `src/renderer/src/pages/editor/hooks/useTaskProgress.ts` | 任务进度 hook |
| PipelineStatusBar | `src/renderer/src/pages/editor/components/PipelineStatusBar.tsx` | 管线状态栏 |
| MediaParser | `src/renderer/src/pages/editor/components/right-panel/MediaParser.tsx` | 媒体解析面板 |
| ShotEditor | `src/renderer/src/pages/editor/components/right-panel/ShotEditor.tsx` | 镜头编辑器 |

### 1.5 Main 进程非控制器消费者（使用 IPC_CHANNELS 做 send）

| 文件 | 路径 | 用途 |
|------|------|------|
| AIEngine | `src/main/engine/AIEngine.ts` | AI 引擎内部 send 进度 |
| JobScheduler | `src/main/core/JobScheduler.ts` | 任务调度器 send 进度 |
| MainNotifier | `src/main/core/MainNotifier.ts` | 主进程通知器 send |
| AIService | `src/main/services/AIService.ts` | AI 服务 send 流式 |
| PipelineEngine | `src/main/engine/PipelineEngine.ts` | 管线引擎 send 进度 |
| TaskEventBus | `src/main/engine/TaskEventBus.ts` | 任务事件总线 send |

---

## 二、IPC 频道完整清单（按域分组）

所有频道常量定义于 `shared/utils/IpcConstants.ts` 的 `IPC_CHANNELS` 对象中（`as const`）。

### 2.1 系统与通用

| 频道常量 | 频道字符串 | 通信方向 | 注册位置 | 调用方 |
|---------|-----------|---------|---------|--------|
| `SYSTEM_GET_PATHS` | `system:getPaths` | invoke | SystemController | API.system.getPaths, preload system |
| `SYSTEM_RESIZE` | `system:resize-window` | invoke | SystemController | API.system.resizeWindow |
| `SYSTEM_CLOSE` | `window-close` | invoke/send | SystemController | API.system.close, preload system |
| `SYSTEM_MINIMIZE` | `window-minimize` | invoke/send | SystemController | API.system.minimize, preload system |
| `SYSTEM_MAXIMIZE` | `window-maximize` | invoke/send | SystemController | API.system.maximize, preload system |
| `SYSTEM_SETTING_GET` / `SETTINGS_GET` | `settings:get` | invoke | SystemController + SettingsController | API.system.getSetting, preload system |
| `SYSTEM_SETTING_SET` / `SETTINGS_SET` | `settings:set` | invoke | SystemController + SettingsController | API.system.setSetting, preload system |
| `SYSTEM_OPEN_DIR` | `dialog:openDirectory` | invoke | SystemController | API.system.openDirectory, preload system |
| `SYSTEM_OPEN_MEDIA` | `dialog:openMedia` | invoke | SystemController | API.system.openMediaDialog, preload system |
| `WINDOW_SWITCH_VIEW` | `switch-view` | send | main/index.ts (on) | preload system.switchView |
| `WINDOW_MINIMIZE` | `window-minimize` | send | main/index.ts (on) | preload system.minimize |
| `WINDOW_MAXIMIZE` | `window-maximize` | send | main/index.ts (on) | preload system.maximize |
| `WINDOW_CLOSE` | `window-close` | send | main/index.ts (on) | preload system.close |
| `APP_READY` | `app-is-ready` | send | main/index.ts (on) | preload system.appIsReady |
| `SYSTEM_GET_SETTINGS` | `system:getSettings` | invoke | SystemController | — |
| `SYSTEM_SAVE_SETTINGS` | `system:saveSettings` | invoke | SystemController | — |
| `SYSTEM_TEST_LLM` | `system:testLLM` | invoke | AIController | — |
| `SYSTEM_MIGRATE` | `system:migrateProjects` | invoke | SystemController | API.system.migrateProjects, preload system |
| `SYSTEM_LOG` | `system:log` | send | — | preload system.log |
| `SYSTEM_OPEN_PATH` | `system:open-path` | invoke | SystemController | API.system.openPath |
| `system:health` | `system:health` (hardcoded) | invoke | EngineController | API.system.health |
| `system:smoke-test` | `system:smoke-test` (hardcoded) | invoke | EngineController | API.system.smokeTest |

### 2.2 媒体管理

| 频道常量 | 频道字符串 | 通信方向 | 注册位置 | 调用方 |
|---------|-----------|---------|---------|--------|
| `MEDIA_IMPORT` | `media:import` | invoke | MediaController | API.media.import, preload media |
| `MEDIA_UPDATE` | `media:update` | invoke | MediaController | API.media.update |
| `MEDIA_PROCESS` | `media:process` | invoke | MediaController | API.media.process, preload media |
| `MEDIA_EXTRACT_FRAMES` | `media:extractFrames` | invoke | MediaController | API.media.extractFrames |
| `MEDIA_CANCEL` | `media:cancelProcess` | invoke | MediaController | API.media.cancelProcess, preload media |
| `MEDIA_DELETE` | `media:delete` | invoke | MediaController | API.media.delete, preload media |
| `MEDIA_GET_BY_PROJECT` | `media:getByProject` | invoke | MediaController | API.media.getByProject |

### 2.3 管线引擎

| 频道常量 | 频道字符串 | 通信方向 | 注册位置 | 调用方 |
|---------|-----------|---------|---------|--------|
| `ENGINE_RUN_PIPELINE` | `engine:run-pipeline` | invoke | EngineController | API.engine.runPipeline |
| `ENGINE_RUN_V1_PIPELINE` | `engine:run-v1-pipeline` | invoke (schema) | EngineController | API.engine.runV1Pipeline |
| `ENGINE_PIPELINE_PROGRESS` | `engine:pipeline-progress` | push (send) | EngineController→renderer | EventBridge, usePipeline 等监听 |
| `ENGINE_ABORT_PIPELINE` | `engine:abort-pipeline` | invoke (schema) | EngineController | API.engine.abortPipeline |
| `ENGINE_PREFLIGHT` | `engine:preflight` | invoke | EngineController | API.engine.preflight |
| `ENGINE_REQUIRE_USER_ACTION` | `engine:require-user-action` | invoke (schema) | EngineController | EventBridge 监听 + invoke |
| `ENGINE_RESUME_PIPELINE` | `engine:resume-pipeline` | invoke (schema) | EngineController | — |
| `PIPELINE_RUN` | `pipeline:run` (legacy) | invoke | AIController | — |
| `PIPELINE_STOP` | `pipeline:stop` (legacy) | invoke | AIController | — |
| `PIPELINE_PROBE_RECOVERY` | `pipeline:probe-recovery` | invoke (schema) | EngineController | — |
| `PIPELINE_RECOVERY_CONTINUE` | `pipeline:recovery-continue` | invoke (schema) | EngineController | — |
| `PIPELINE_RECOVERY_ABANDON` | `pipeline:recovery-abandon` | invoke (schema) | EngineController | — |
| `PIPELINE_UPDATE_PARAMS` | `pipeline:updateParams` | invoke | EngineController | API.engine.updateParams |
| `ENGINE_RUN_DAG_WORKFLOW` | `engine:run-dag-workflow` | invoke | EngineController | API.engine.runDagWorkflow |
| `WORKFLOW_SAVE` | `workflow:save` | invoke | EngineController | API.workflow.save |
| `WORKFLOW_LOAD` | `workflow:load` | invoke | EngineController | API.workflow.load |

### 2.4 项目域

| 频道常量 | 频道字符串 | 通信方向 | 注册位置 | 调用方 |
|---------|-----------|---------|---------|--------|
| `PROJECT_GET_BY_ID` | `project:get-by-id` | invoke | ProjectController | API.project.getById, preload project |
| `PROJECT_LOAD_DATA` | `project:load-data` | invoke | ProjectController | API.project.loadData, preload project |
| `PROJECT_SAVE_DATA` | `project:save-data` | invoke | ProjectController | API.project.saveData, preload project |
| `PROJECT_CREATE` | `project:create` | invoke | ProjectController | API.project.create, preload project |
| `PROJECT_GET_RECENT` | `project:getRecent` | invoke | ProjectController | API.project.getRecent, preload project |
| `PROJECT_GET_LIST` | `project:getList` | invoke | ProjectController | API.project.getAll/getList, preload project |
| `PROJECT_DELETE` | `project:delete` | invoke | ProjectController | API.project.delete, preload project |
| `PROJECT_RENAME` | `project:rename` | invoke | ProjectController | API.project.rename, preload project |
| `PROJECT_DUPLICATE` | `project:duplicate` | invoke | ProjectController | API.project.duplicate, preload project |
| `PROJECT_INSTANTIATE` | `project:instantiate` | invoke | ProjectController | API.project.instantiate |
| `PROJECT_SAVE_CANVAS` | `project:save-canvas` | invoke | ProjectController | API.project.saveCanvas |
| `PROJECT_UPDATE_SCRIPT_DELTA` | `project:update-script-delta` | invoke | ProjectController | API.project.updateScriptDelta |
| `PROJECT_EXPORT` | `project:export` | invoke | ProjectController | API.project.exportProject |

### 2.5 草稿自动保存

| 频道常量 | 频道字符串 | 通信方向 | 注册位置 | 调用方 |
|---------|-----------|---------|---------|--------|
| `DRAFT_SHADOW_SAVE` | `draft:shadow-save` | invoke | ProjectController | IPCBridge.tsx |
| `DRAFT_SHADOW_FLUSH` | `draft:shadow-flush` | invoke | ProjectController | — |
| `DRAFT_SYNC_TO_MAIN` | `draft:sync-to-main` | invoke | ProjectController | — |

### 2.6 任务调度

| 频道常量 | 频道字符串 | 通信方向 | 注册位置 | 调用方 |
|---------|-----------|---------|---------|--------|
| `TASK_GET_ALL` | `task:getAll` | invoke | ProjectController | API.tasks.getAll, preload tasks |
| `TASK_GET_ACTIVE` | `jobs:getActiveTasks` | invoke | ProjectController | API.tasks.getActive, preload tasks |
| `TASK_CANCEL` | `jobs:cancel` | invoke | — | API.tasks.cancel, preload tasks |
| `GET_NODE_OUTPUT` | `task:get-node-output` | invoke | AIController | — |

### 2.7 AI 算力域

| 频道常量 | 频道字符串 | 通信方向 | 注册位置 | 调用方 |
|---------|-----------|---------|---------|--------|
| `AI_TEST_NETWORK` | `ai:testNetwork` | invoke | AIController | API.ai.testNetwork, preload ai |
| `AI_TEST_TTS` | `ai:testTTS` | invoke | AIController | API.ai.testTTS, preload ai |
| `AI_CHAT` | `ai:chat` | invoke | AIController | — |
| `AI_CHAT_STREAM` | `ai:chat-stream` | — | — | — |
| `AI_SCRIPT_PROGRESS` | `ai:script-progress` | — | — | — |
| `AI_GET_HISTORY` | `ai:get-history` | invoke | AIController | — |
| `AI_GENERATE_TTS` | `ai:generateTTS` | invoke | AIController | API.ai.generateTTS, preload ai |
| `AI_RUN_SINGLE_TTS` | `ai:runSingleTTS` | invoke | AIController | API.ai.runSingleTTS, preload ai |
| `AI_RUN_GLOBAL_TTS` | `ai:runGlobalTTS` | invoke | AIController | API.ai.runGlobalTTS, preload ai |
| `AI_VISION_SINGLE` | `ai:visionSingle` | invoke | AIController | API.ai.visionSingle, preload ai |
| `AI_VISION_EXTRACT` | `vision:extract` | invoke | AIController | API.ai.visionExtract |
| `AI_EMOTION_SINGLE` | `ai:emotionSingle` | invoke | AIController | API.ai.emotionSingle, preload ai |
| `AI_GENERATE_SCRIPT` | `ai:generateAiScript` | invoke | AIController | API.ai.generateAiScript, preload ai |
| `AI_STREAM_TEXT` | `ai:streamText` | send | — | API.ai.streamText, preload ai |
| `AI_SEARCH_SEMANTICS` | `ai:searchSemantics` | invoke | AIController | API.ai.searchSemantics |
| `AI_CHAT_REQUEST` | `ai:chatRequest` | invoke | AIController | — |
| `AI_SEARCH_BROLL` | `ai:searchBroll` | invoke | AIController | API.engine.searchBroll |
| `AI_ISOLATE_VOCALS` | `ai:isolateVocals` | invoke | AIController | — |
| `AI_EXTRACT_FRAMES` | `ai:extractFrames` | invoke | AIController | API.engine.extractFrames |

### 2.8 AI Agent 流式域

| 频道常量 | 频道字符串 | 通信方向 | 注册位置 | 调用方 |
|---------|-----------|---------|---------|--------|
| `AGENT_CHAT_INVOKE` | `agent:chatInvoke` | invoke | AIController | preload invokeAgentChat |
| `AGENT_STREAM_START` | `agent:streamStart` | push (send) | AIController→renderer | preload onAgentStreamStart |
| `AGENT_STREAM_CHUNK` | `agent:streamChunk` | push (send) | AIController→renderer | preload onAgentStreamChunk |
| `AGENT_TOOL_CALL` | `agent:toolCall` | push (send) | AIController→renderer | preload onAgentToolCall |
| `AGENT_STREAM_DONE` | `agent:streamDone` | push (send) | AIController→renderer | preload onAgentStreamDone |
| `AGENT_STREAM_ERROR` | `agent:streamError` | push (send) | AIController→renderer | preload onAgentStreamError |
| `AGENT_GET_HISTORY` | `agent:getHistory` | invoke | AIController | preload getAgentHistory |
| `AGENT_MARK_EXECUTED` | `agent:markExecuted` | invoke | AIController | preload markAgentActionExecuted |

### 2.9 导出域

| 频道常量 | 频道字符串 | 通信方向 | 注册位置 | 调用方 |
|---------|-----------|---------|---------|--------|
| `EXPORT_JIANYING` | `export:jianying` | invoke (schema) | ExportController | API.export.jianying, preload export |
| `EXPORT_LOCAL_VIDEO` | `export:video` | invoke | ExportController | API.export.localVideo, preload export |
| `EXPORT_MP4_RENDER` | `export:mp4Render` | invoke | EngineController | API.export.mp4Render |
| `EXPORT_PUBLISH_PACKAGE` | `export:publishPackage` | invoke | EngineController | API.export.publishPackage |
| `EXPORT_SUBTITLE` | `export:subtitle` | invoke | — (未注册?) | API.export.subtitle |
| `EXPORT_TXT` | `export:txt` | invoke | — (未注册?) | API.export.txt |
| `EXPORT_PROGRESS` | `export:progress` | — | — | — |

### 2.10 事件推送（Main → Renderer）

| 频道常量 | 频道字符串 | 通信方向 | 发送方 | 监听方 |
|---------|-----------|---------|--------|--------|
| `EVENT_TASK_PROGRESS` | `task:progress` | push | JobScheduler, TaskEventBus | EventBridge, useTaskStore, preload events |
| `EVENT_TASK_COMPLETED` | `task:completed` | push | JobScheduler, TaskEventBus | EventBridge, preload events |
| `EVENT_APP_NOTIFY` | `app:notify` | push | MainNotifier | EventBridge, preload events |
| `EVENT_EXTRACTION_SUCCESS` | `event:extraction-success` | push | JobScheduler | EventBridge, API.events, IPCBridge, preload events |
| `EVENT_MEDIA_UPDATED` | `event:media-updated` | push | — | EventBridge, API.events, preload events |
| `EVENT_NODE_STATE_CHANGE` | `event:node-state-change` | push | — | EventBridge |
| `EVENT_PIPELINE_ERROR` | `event:pipeline-error` | push | EngineController | IPCBridge.tsx |
| `EVENT_STREAM_SAFE_CHUNK` | `event:stream-safe-chunk` | push | — | — |
| `EVENT_STREAM_TO_SHOT_CARD` | `event:stream-to-shot-card` | push | EngineController | IPCBridge.tsx |

### 2.11 语音 / 音色

| 频道常量 | 频道字符串 | 注册位置 | 备注 |
|---------|-----------|---------|------|
| `VOICE_PREVIEW` | `voice:preview` | AIController + EngineController | **重复注册**，EngineController 后注册胜出 |
| `VOICE_LIST_BY_ENGINE` | `voice:listByEngine` | AIController + EngineController | **重复注册**，EngineController 后注册胜出 |
| `voice:clone` | `voice:clone` (hardcoded) | AIController | 唯一注册 |
| `voice:get-cloned-voices` | `voice:get-cloned-voices` (hardcoded) | AIController + EngineController | **重复注册**，EngineController 后注册胜出 |
| `voice:delete-cloned` | `voice:delete-cloned` (hardcoded, schema) | EngineController | 唯一注册，带 Zod 校验 |

### 2.12 角色管理

| 频道常量 | 频道字符串 | 注册位置 | 调用方 |
|---------|-----------|---------|--------|
| `ROLE_LIST` | `role:list` | EngineController | API.roles.list |
| `ROLE_UPDATE_VOICE` | `role:updateVoice` | EngineController | API.roles.updateVoice |

### 2.13 用户体系

| 频道常量 | 频道字符串 | 注册位置 | 调用方 |
|---------|-----------|---------|--------|
| `USER_REGISTER` | `user:register` | UserController | API.user.register |
| `USER_LOGIN` | `user:login` | UserController | API.user.login |
| `USER_LOGOUT` | `user:logout` | UserController | API.user.logout |
| `USER_GET_PROFILE` | `user:getProfile` | UserController | API.user.getProfile |
| `USER_UPDATE_PROFILE` | `user:updateProfile` | UserController | API.user.updateProfile |
| `USER_CHANGE_PASSWORD` | `user:changePassword` | UserController | API.user.changePassword |
| `USER_CHECK_SESSION` | `user:checkSession` | UserController | API.user.checkSession |
| `USER_ACTIVATE_VIP` | `user:activateVip` | UserController | API.user.activateVip |
| `USER_GET_VIP_INFO` | `user:getVipInfo` | UserController | API.user.getVipInfo |

### 2.14 模型管理

| 频道常量 | 频道字符串 | 注册位置 | 调用方 |
|---------|-----------|---------|--------|
| `MODEL_GET_LIST` | `model:getList` | ModelController | API.model.getList |
| `MODEL_DOWNLOAD` | `model:download` | ModelController | API.model.download |
| `MODEL_DOWNLOAD_PROGRESS` | `model:downloadProgress` | push (ModelController) | API.model.onDownloadProgress |
| `MODEL_UNINSTALL` | `model:uninstall` | ModelController | API.model.uninstall |
| `MODEL_CHECK_UPDATE` | `model:checkUpdate` | ModelController | API.model.checkUpdate |
| `MODEL_UPDATE` | `model:update` | ModelController | API.model.update |
| `MODEL_SET_PATH` | `model:setPath` | ModelController | API.model.setPath |
| `MODEL_BATCH_DOWNLOAD` | `model:batchDownload` | ModelController | API.model.batchDownload |
| `MODEL_BATCH_UPDATE` | `model:batchUpdate` | ModelController | API.model.batchUpdate |
| `PIPELINE_GET_NODE_MODEL_CONFIG` | `pipeline:getNodeModelConfig` | ModelController | API.pipelineModel.getNodeModelConfig |
| `PIPELINE_SET_NODE_MODEL` | `pipeline:setNodeModel` | ModelController | API.pipelineModel.setNodeModel |
| `PIPELINE_RESET_NODE_MODEL` | `pipeline:resetNodeModel` | ModelController | API.pipelineModel.resetNodeModel |
| `PIPELINE_TEST_NODE_MODEL` | `pipeline:testNodeModel` | ModelController | API.pipelineModel.testNodeModel |

### 2.15 设置扩展

| 频道常量 | 频道字符串 | 注册位置 | 调用方 |
|---------|-----------|---------|--------|
| `SETTINGS_GET_ALL` | `settings:getAll` | SettingsController | API.settingsExt.getAll |
| `SETTINGS_GET_BY_KEYS` | `settings:getByKeys` | SettingsController | API.settingsExt.getByKeys |
| `SETTINGS_RESET_ALL` | `settings:resetAll` | SettingsController | API.settingsExt.resetAll |
| `SETTINGS_VALIDATE_PATH` | `settings:validatePath` | SettingsController | API.settingsExt.validatePath |

### 2.16 批量队列

| 频道常量 | 频道字符串 | 注册位置 | 调用方 |
|---------|-----------|---------|--------|
| `BATCH_QUEUE_ADD` | `batch:queueAdd` | EngineController | API.queue.add |
| `BATCH_QUEUE_START` | `batch:queueStart` | EngineController | API.queue.start |
| `BATCH_QUEUE_STATUS` | `batch:queueStatus` | EngineController | API.queue.status |
| `BATCH_QUEUE_PAUSE` | `batch:queuePause` | EngineController | API.queue.pause |
| `BATCH_QUEUE_REMOVE` | `batch:queueRemove` | EngineController | API.queue.remove |
| `BATCH_QUEUE_REORDER` | `batch:queueReorder` | EngineController | API.queue.reorder |
| `BATCH_QUEUE_RETRY` | `batch:queueRetry` | EngineController | API.queue.retry |
| `BATCH_PROGRESS` | `batch:progress` | push (EngineController) | API.events.onBatchProgress |

### 2.17 API Profiles

| 频道常量 | 频道字符串 | 注册位置 | 调用方 |
|---------|-----------|---------|--------|
| `API_PROFILE_GET_ALL` | `apiProfile:getAll` | ApiProfileController | preload apiProfile.getAll |
| `API_PROFILE_GET_BY_PROVIDER` | `apiProfile:getByProvider` | ApiProfileController | preload apiProfile.getByProvider |
| `API_PROFILE_CREATE` | `apiProfile:create` | ApiProfileController | preload apiProfile.create |
| `API_PROFILE_UPDATE` | `apiProfile:update` | ApiProfileController | preload apiProfile.update |
| `API_PROFILE_DELETE` | `apiProfile:delete` | ApiProfileController | preload apiProfile.delete |
| `API_PROFILE_ACTIVATE` | `apiProfile:activate` | ApiProfileController | preload apiProfile.activate |
| `BINDING_GET_ALL` | `profileBinding:getAll` | ApiProfileController | preload profileBinding.getAll |
| `BINDING_GET_BY_TASK` | `profileBinding:getByTask` | ApiProfileController | preload profileBinding.getByTask |
| `BINDING_UPSERT` | `profileBinding:upsert` | ApiProfileController | preload profileBinding.upsert |

### 2.18 License / 反馈（已迁移或未使用）

| 频道常量 | 频道字符串 | 状态 |
|---------|-----------|------|
| `LICENSE_VALIDATE` | `license:validate` | 已迁移至 VIP 激活码体系，EngineController 返回迁移提示 |
| `LICENSE_STATUS` | `license:status` | 已迁移至 VIP 激活码体系 |
| `FEEDBACK_TOAST` | `feedback:toast` | 已定义未注册 |
| `FEEDBACK_MODAL` | `feedback:modal` | 已定义未注册 |
| `FEEDBACK_INLINE` | `feedback:inline` | 已定义未注册 |
| `FEEDBACK_GET` | `feedback:get` | 已定义未注册 |
| `FEEDBACK_CLEAR` | `feedback:clear` | 已定义未注册 |
| `PIPELINE_PROBE_CACHE` | `pipeline:probe-cache` | 已定义未注册 |

---

## 三、核心模块详细分析

### 3.1 IpcRouter (`src/main/core/IpcRouter.ts`)

#### 导出接口

| 方法 | 签名 | 功能 |
|------|------|------|
| `IpcRouter.handle()` | `static handle(channel: string, handler: IpcHandler): void` | 注册 ipcMain.handle，自动异常捕获 + 日志 + 防热更新重复绑定 |
| `IpcRouter.handleWithSchema()` | `static handleWithSchema(channel: string, schema: ZodTypeAny, handler: IpcHandler): void` | 同上 + 自动 Zod schema 校验 payload |

#### 依赖

| 导入 | 来源 |
|------|------|
| `ipcMain` | `electron` |
| `AppLogger` | `../core/AppLogger` |
| `LOG_TAGS` | `../../shared/utils/LogConstants` |
| `IPC_ERROR_CODES, IpcResponse` | `../../shared/contracts/ipc` |
| `z (Zod)` | `zod` |

#### 被谁导入

全部 10 个 Controller 文件：

- `src/main/controllers/SystemController.ts`
- `src/main/controllers/SettingsController.ts`
- `src/main/controllers/ProjectController.ts`
- `src/main/controllers/MediaController.ts`
- `src/main/controllers/AIController.ts`
- `src/main/controllers/EngineController.ts`
- `src/main/controllers/ExportController.ts`
- `src/main/controllers/UserController.ts`
- `src/main/controllers/ModelController.ts`
- `src/main/controllers/ApiProfileController.ts`

### 3.2 IpcConstants (`src/shared/utils/IpcConstants.ts`)

#### 导出

```typescript
export const IPC_CHANNELS = { /* ~120+ 频道常量 */ } as const;
```

#### 被谁导入（30 个文件）

**Main 进程 (15)**:
- 10 个 Controller 文件
- `main/engine/AIEngine.ts`
- `main/core/JobScheduler.ts`
- `main/core/MainNotifier.ts`
- `main/services/AIService.ts`
- `main/engine/PipelineEngine.ts`
- `main/engine/TaskEventBus.ts`

**Renderer 进程 (13)**:
- `renderer/src/api/index.ts`
- `renderer/src/core/IPCBridge.tsx`
- `renderer/src/bridge/EventBridge.ts`
- `renderer/src/store/useTaskStore.ts`
- `renderer/src/store/hooks/usePipeline.ts`
- `renderer/src/pages/editor/hooks/usePipelineExecutor.ts`
- `renderer/src/pages/editor/hooks/useEditorLogic.ts`
- `renderer/src/pages/editor/hooks/usePipelineOrchestrator.ts`
- `renderer/src/pages/editor/hooks/useTaskProgress.ts`
- `renderer/src/pages/editor/components/PipelineStatusBar.tsx`
- `renderer/src/pages/editor/components/right-panel/MediaParser.tsx`
- `renderer/src/pages/editor/components/right-panel/ShotEditor.tsx`

**Preload (1)**:
- `src/preload/index.ts`

**Shared (1)**:
- `src/shared/contracts/registry.ts`

### 3.3 contracts/ipc (`src/shared/contracts/ipc.ts`)

#### 导出

| 符号 | 类型 | 说明 |
|------|------|------|
| `BASE_IPC_RESPONSE_SCHEMA` | `ZodObject` | 标准响应 Zod Schema（success, data?, error?, meta?） |
| `IpcResponse<T>` | TypeScript 接口 | 标准响应泛型接口 |
| `IPC_ERROR_CODES` | `const` object | 错误码常量（VALIDATION_ERROR, PIPELINE_NOT_FOUND 等 9 个） |
| `CREATE_ERROR_RESPONSE` | 工厂函数 | `(code, message, userIdMessage?) => { success: false, error: {...} }` |
| `CREATE_SUCCESS_RESPONSE` | 工厂函数 | `<T>(data) => IpcResponse<T>` |
| `VALIDATION_ERROR_RESPONSE` | 工厂函数 | `(message) => { success: false, error: {...} }` |

#### 被谁导入

- `src/main/core/IpcRouter.ts`

### 3.4 contracts/registry (`src/shared/contracts/registry.ts`)

#### 导出

| 符号 | 类型 | 说明 |
|------|------|------|
| `SCHEMA_REGISTRY` | `Record<string, ZodTypeAny>` | 9 个频道的 Zod Schema 注册表 |
| `getSchema(channel)` | 函数 | 获取频道 Schema |
| `isChannelGuarded(channel)` | 函数 | 检查频道是否已接入校验 |

#### 已注册 Schema 的频道

| 频道 | Schema |
|------|--------|
| `engine:run-v1-pipeline` | `{ projectId, mediaId, mediaPath }` |
| `engine:resume-pipeline` | `{ projectId, mediaId, userInput? }` |
| `engine:require-user-action` | `{ projectId, mediaId }` |
| `engine:abort-pipeline` | `{ projectId?, mediaId? }` |
| `pipeline:probe-recovery` | `{ projectId }` |
| `pipeline:recovery-continue` | `{ projectId }` |
| `pipeline:recovery-abandon` | `{ projectId }` |
| `voice:delete-cloned` | `{ cloneId }` |
| `export:jianying` | `{ projectId }` + passthrough |

### 3.5 types/ipc (`src/shared/types/ipc.ts`)

#### 导出

```typescript
export interface IpcResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  errorCode?: string | number;
}
```

#### 被谁导入

**未被任何文件导入**（简化版，与 `contracts/ipc.ts` 功能重复，可以视为死代码）。

### 3.6 Preload 桥接层 (`src/preload/index.ts`)

#### 导出（通过 contextBridge 暴露到 `window.api`）

```typescript
const api = {
  project: { getById, loadData, saveData, getRecent, getList, create, delete, rename, duplicate },
  media: { import, process, cancelProcess, delete },
  system: { getSetting, setSetting, getPaths, migrateProjects, openDirectory, openMediaDialog,
            switchView, minimize, maximize, close, appIsReady, log },
  tasks: { getAll, getActive, cancel },
  ai: { generateTTS, testNetwork, testTTS, runSingleTTS, runGlobalTTS,
        visionSingle, emotionSingle, generateAiScript, streamText },
  export: { jianying, localVideo },
  events: { onTaskProgress, onTaskCompleted, onAppNotify, onExtractionSuccess, onMediaUpdated, removeAll },
  invoke: safeInvoke,           // 通用 invoke
  invokeAgentChat,              // Agent 流式
  getAgentHistory,
  markAgentActionExecuted,
  onAgentStreamStart, onAgentStreamChunk, onAgentToolCall, onAgentStreamDone, onAgentStreamError,
  removeAllAgentListeners,
  ipc: { invoke, send, on, removeListener, removeAllListeners },  // 底层安全包装
  profileBinding: { getAll, getByTask, upsert },
  apiProfile: { getAll, getByProvider, create, update, delete, activate },
  versions: process.versions,
}
```

#### 安全包装器

- `safeInvoke(channel, ...args)` — 拦截空信道 + 调用 `ipcRenderer.invoke`
- `safeSend(channel, ...args)` — 拦截空信道 + 调用 `ipcRenderer.send`
- `safeOn(channel, callback)` — 拦截空信道 + 调用 `ipcRenderer.on`
- `safeRemoveAllListeners(channel)` — 拦截空信道 + 调用 `ipcRenderer.removeAllListeners`

#### 类型声明 (`src/preload/index.d.ts`)

```typescript
export interface StrictlyTypedIpcRenderer {
  invoke<K extends keyof IPCInvokeChannels>(
    channel: K, ...args: Parameters<IPCInvokeChannels[K]>
  ): ReturnType<IPCInvokeChannels[K]>;
  on<K extends keyof IPCEventChannels>(
    channel: K, listener: (...) => void
  ): this;
  send(channel: string, ...args: any[]): void;
  removeAllListeners(channel: string): this;
}
```

**注意**：`IPCInvokeChannels` 和 `IPCEventChannels` 类型从 `'../shared/types'` 导入，但这两个类型在 `shared/types/index.ts` 中**并不存在**。当前 `window.api.ipc.invoke` 实际通过 `env.d.ts` 中的 `WindowApi` 接口使用 `any` 类型兜底。

### 3.7 IPCBridge 组件 (`src/renderer/src/core/IPCBridge.tsx`)

React 组件，在 `useEffect` 中通过 `window.api.ipc.on` 监听 4 个推送事件：

| 频道 | 处理逻辑 |
|------|---------|
| `EVENT_PIPELINE_ERROR` | 将错误信息写入 `pipelineErrorsAtom` |
| `EVENT_STREAM_TO_SHOT_CARD` | 解析 JSON 安全文本，更新对应 shot 卡片 |
| `'NOTIFY_PIPELINE_EVENT'` (hardcoded) | 管线事件通知处理 |
| `PROJECT_SAVE_CANVAS` | 触发 `draft:sync-to-main` 同步 |

---

## 四、进程间通信架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    Renderer Process                         │
│                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  API facade  │  │  EventBridge  │  │  IPCBridge.tsx   │   │
│  │  (api/index) │  │  (单例事件桥) │  │  (React 组件)    │   │
│  │              │  │              │  │                  │   │
│  │ invoke()     │  │ subscribe()  │  │ useEffect()      │   │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘   │
│         │                 │                    │             │
│         └─────────┬───────┴────────────────────┘             │
│                   │                                          │
│          window.api.ipc.invoke/on/send                       │
│          window.api.system/ai/events/...                     │
└───────────────────┼──────────────────────────────────────────┘
                    │
     ═══════════════╪══════════════════════════════════
         contextBridge (Preload — 安全包装层)
     ═══════════════╪══════════════════════════════════
                    │
         ┌──────────┴──────────┐
         │   safeInvoke()      │  拦截空信道 + schema 校验前移
         │   safeSend()        │
         │   safeOn()          │
         └──────────┬──────────┘
                    │
              ipcRenderer.invoke / ipcMain.handle
                    │
     ═══════════════╪══════════════════════════════════
                    │
┌───────────────────┼──────────────────────────────────────────┐
│                   │      Main Process                        │
│        ┌──────────┴──────────┐                               │
│        │     IpcRouter       │  封装 ipcMain.handle          │
│        │  .handle()          │  + 异常捕获 + 日志            │
│        │  .handleWithSchema()│  + Zod 校验 + 防热更新重复    │
│        └──────────┬──────────┘                               │
│                   │                                          │
│     ┌─────────────┼─────────────┐                            │
│     │             │             │                            │
│  ┌──┴──┐    ┌────┴────┐   ┌───┴────┐                       │
│  │10个  │    │Engine   │   │其他    │                       │
│  │Ctrl  │    │Services │   │Service │                       │
│  └─────┘    └─────────┘   └────────┘                       │
│                                                             │
│  Main → Renderer 推送 (send):                                │
│  JobScheduler.send(EVENT_TASK_PROGRESS)                     │
│  EngineController.send(ENGINE_PIPELINE_PROGRESS)            │
│  AIEngine.send(AGENT_STREAM_CHUNK)                          │
└─────────────────────────────────────────────────────────────┘
```

**注册顺序决定 handler 胜出**（`main/index.ts` L161-176）：

当同一频道被多个 Controller 注册时，Electron 的 `ipcMain.handle` 机制是**最后一个注册者胜出**。

当前重复注册的频道及生效者：

| 频道 | AIController 实现 | EngineController 实现 | 生效者 |
|------|------------------|---------------------|--------|
| `voice:preview` | `AIEngine.generateTTS` | `TTSProvider.synthesize` | EngineController |
| `voice:listByEngine` | hardcoded + moss HTTP fetch | `getVoicesForEngine()` | EngineController |
| `voice:get-cloned-voices` | fs-based clones 目录读取 | `LocalAiGateway.getClonedVoices()` | EngineController |

---

## 五、Schema 注册表覆盖

`shared/contracts/registry.ts` 中 `SCHEMA_REGISTRY` 注册了 9 个频道的 Zod Schema：

| # | 频道 | Schema 字段 | strict/passthrough |
|---|------|-----------|-------------------|
| 1 | `engine:run-v1-pipeline` | projectId, mediaId, mediaPath | strict |
| 2 | `engine:resume-pipeline` | projectId, mediaId, userInput? | strict |
| 3 | `engine:require-user-action` | projectId, mediaId | strict |
| 4 | `engine:abort-pipeline` | projectId?, mediaId? | optional |
| 5 | `pipeline:probe-recovery` | projectId | strict |
| 6 | `pipeline:recovery-continue` | projectId | strict |
| 7 | `pipeline:recovery-abandon` | projectId | strict |
| 8 | `voice:delete-cloned` | cloneId | strict |
| 9 | `export:jianying` | projectId | passthrough |

---

## 六、迁移建议

### 6.1 目标结构

```
src/infra/ipc/
  ├── IpcConstants.ts        ← 从 shared/utils/IpcConstants.ts 复制
  ├── IpcRouter.ts           ← 从 main/core/IpcRouter.ts 复制
  ├── ipc-contracts.ts       ← 从 shared/contracts/ipc.ts 复制
  ├── ipc-schema-registry.ts ← 从 shared/contracts/registry.ts 复制
  ├── ipc-types.ts           ← 从 shared/types/ipc.ts 复制（可考虑合并到 ipc-contracts.ts）
  └── index.ts               ← barrel 文件
```

### 6.2 迁移注意事项

1. **IpcRouter.ts** 依赖 `AppLogger` 和 `LogConstants`——需确认这些模块是否已迁到 `infra/`
2. **IpcConstants.ts** 被 30 个文件导入——需批量更新 import 路径；可保留旧文件为 `@deprecated` 重导出
3. **contracts/ipc.ts** 被 `IpcRouter.ts` 导入——迁移后需同步更新 internal import
4. **contracts/registry.ts** 导入了 `IpcConstants`（相对路径 `../../shared/utils/IpcConstants`）——迁移后需更新
5. **重复注册问题**：`voice:preview`、`voice:listByEngine`、`voice:get-cloned-voices` 在 AIController 和 EngineController 中重复注册——应清理 AIController 中的冗余 handler
6. **未注册频道**：`EXPORT_SUBTITLE`、`EXPORT_TXT`、`TASK_CANCEL` 在 API 层有调用但未找到对应的 handler——需确认是否遗漏
7. **IPCInvokeChannels / IPCEventChannels 类型缺失**：`preload/index.d.ts` 引用了不存在的类型，建议补充完整的类型映射
