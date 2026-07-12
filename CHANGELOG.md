# Changelog

## [Unreleased]

### Added (B4 — Runtime & Feedback)
- **HealthPage**: 系统健康中心页面，含冒烟检查、硬件信息、服务状态面板
- **HealthService**: 健康数据收集服务，支持 `collect()` 全量报告 + `smokeTest()` 快速冒烟
- **CrashReporter**: 崩溃报告器，捕获 `uncaughtException/unhandledRejection`，自动保存本地 JSON 报告并保留最近 20 条
- **TelemetryOptInGate**: 遥测隐私授权门控，控制 `crash/usage/feature/performance` 数据收集权限
- **UsageStatsCollector**: 本地使用统计（SQLite，不联网），按类别/动作追踪并支持 90 天自动清理
- **ExporterPluginRegistry**: 导出器插件注册表，内置 `jianying` 和 `local-json` 两套导出格式
- **ComputeResourceManager**: 计算资源监控，含 `snapshot()/shouldThrottle()/canStartNewTask()` 限流接口

### Added (B3 — Security & AI Decouple)
- **HttpClient**: 泛化 HTTP 客户端，从 AIDaemon.post() 提取，内置超时/重试/AbortController
- **LocalAiGateway**: 本地 AI 服务网关，收口所有对 Python REST 的调用，阻断 renderer 直连
- **CredentialManager**: 凭据生命周期管理，封装 safeStorage + 脱敏显示 + 格式校验
- **FrameExtractor**: 原子化帧抽取能力，从 AIEngine 拆出，支持均匀/关键帧/场景/fps 四种策略
- **TTSProvider**: 独立语音合成能力，从 AIEngine 拆出，支持 doubao/edge/fish/sovits/moss 五种引擎
- Renderer 直连迁移完成：2 处 `fetch(127.0.0.1:9882)` 已全部迁移至 IPC 代理
- **SettingsRepository** 普通/敏感配置分层：敏感 key 加密存储，普通 key 明文存储

### Added (B2 — Pipeline & Task Platform)
- **TaskEventBus**: 统一任务事件总线，封装 6 类 pipeline 事件，内置 MainNotifier 适配器
- **PipelineSuspendController**: 人机交替挂起/恢复机制，Promise-based 等待
- **DBWriteBatcher**: 批量写入优化器，50ms 去抖窗口 + coalesce 合并策略
- **EventBridge**: 渲染进程事件桥接，统一管理 main→renderer IPC 订阅
- **DraftSyncService**: 草稿同步守护进程，500ms 防抖自动持久化至 IndexedDB

### Added (B1 — Contract & Config Foundation)
- Contracts 契约层 (`src/shared/contracts/`): ipc / pipeline / task / capabilities Zod schema
- Config 配置层 (`src/shared/config/`): keys 集中式常量 + feature-flags 编译期开关
- IPC 通道扩展：ENGINE_RUN_V1_PIPELINE / REQUIRE_USER_ACTION / RESUME_PIPELINE / 恢复端点
- **CheckpointRepository**: SQLite checkpoint 操作仓库封装
- **PipelineRecoveryService**: Pipeline 崩溃恢复服务
- **DatabaseWriteQueue**: 数据库写入队列（防 SQLITE_BUSY）
- Pipeline 路由注册表 (`pipeline-routes.ts`)

### Cleaned (C1 — Deprecated Code Removal, Round 1)
- **pages/editor @deprecated 批量清理 (R1)**: 移除重构遗留死码 34 个文件（2,240 行），含 Step/View 容器家族、hooks 家族 (useEditorLogic 等 8 个)、工具函数 (timeFormat/pipelineConstants)、入口页面 (editor/home index)、废弃组件 (PipelineStatusBar/PropertyBar/StepPanel)
- **core/parsers 死码移除**: AudioSeparateParser + barrel index.ts，全仓 0 引
- **pages/modules 同名重复清理 (R2+R3)**: 9 组内容等价/升级文件迁移 — R2 6 组（usePipelineResultMapper / scriptDiffTree / ExportCheckbox / DeleteModal / RenameModal / useWorkflowImport，4 处 import）；R3 3 组升级版（ExportModal → editorStore 收口 / ProjectCard → 函数重写 / useProjectManager → 字段兼容映射，2 处 import）
- **shared/ 跳板文件铲除 (R4)**: 8 个 @deprecated export 转发空壳全部删除，28 处 IpcConstants import 迁移至 modules/infra/ipc/，空目录 locales/ 一并清理
- **备份文件清理**: 5 个 `_20260704_` 时间戳备份文件物理删除
- **.gitignore**: 新增 `test/` 目录排除规则，防止 Python 字节码污染

### Added (B5 — Skin System & UI Polish)
- **#7 编辑器 Token 化**: 编辑器文本渲染从纯文本升级为语义 Token（对话/旁白/动作/标注），支持富样式可视化区分
- **#5 粒子效果优化**: 粒子发射器性能调优，帧率提升 30%，粒子数量上限从 500 提升至 2000
- **#6+#8 配色统一**: 全局 UI 色板统一为 Zentect Design Token，含编辑区/时间轴/导出面板三模块

### Changed
- `SimplePipelineRunner.ts`: 集成 CheckpointRepository + TaskEventBus + PipelineSuspendController
- `EngineController.ts`: 新增 8 个 IPC 端点（恢复/挂起/语音克隆/健康检测）
- `JobScheduler.ts`: 恢复逻辑委托至 PipelineRecoveryService
- `SettingsRepository.ts`: 凭据管理迁移至 CredentialManager + 敏感键自动加密
- `useTaskStore.ts`: IPC 迁移至 EventBridge
- `useStore.ts`: 草稿同步逻辑抽离至 DraftSyncService
- `ExportService.ts`: 自建 DB 加载能力
- `AITab.tsx`: 直连 fetch 消除，改为 IPC 代理

### Fixed
- Zod v4 API 兼容：`z.record(z.unknown())` → `z.record(z.string(), z.unknown())`
- SimplePipelineRunner `'asr'` → `'whisper'` 类型修正
- ExportService ProjectRepository 方法名 `load` → `loadFullProjectData`
- StepProgress 接口新增 `'suspended'` 状态

## [1.0.0] — PRE-REFACTORING BASELINE

### Infrastructure
- Electron + React + TypeScript + SQLite (better-sqlite3)
- Python FastAPI AI daemon
- Zustand state management
- electron-vite build system
- Zod runtime validation
