# Step4-TTS 模块现状分析

> 生成时间: 2026-07-04  
> 分析范围: 前端 TTS 组件 / Store 状态 / API 层 / 后端策略与能力 / IPC 注册

---

## 1. 代码分布

### 1.1 前端（renderer/src/）

| 文件 | 行数 | 角色 |
|---|---|---|
| `pages/editor/components/steps/StepTTSSynthesis.tsx` | 148 | Step4 智能组件：引擎/音色选择、试听、合成调度 |
| `pages/editor/components/steps/containers/StepTTSSynthesisView.tsx` | 134 | Step4 纯展示组件：UI 渲染（引擎标签、音色卡片、进度条、结果列表） |
| `core/parsers/TTSParser.ts` | 20 | 管线节点解析器：将 DAG 节点转为 `PipelineTask { actionType: 'tts-synthesize' }` |
| `store/storeTypes.ts` | 270* | EditorSlice 类型定义（含 ttsEngine / ttsVoiceId / ttsProgress / ttsResults） |
| `store/slices/editorSlice.ts` | 188* | TTS 状态实现：zustand slice，含 setTtsEngine / setTtsVoiceId / setTtsProgress / setTtsResults |
| `store/usePipelineStore.ts` | 105 | 管线状态独立 Store（stepStatuses / pipelineRunning 等） |
| `api/index.ts` | 340* | API.voice 封装：preview / listByEngine / getClonedVoices；API.engine.runPipeline |
| `pages/editor/utils/pipelineConstants.ts` | 80* | STEP_SEQUENCES[4] → `{ actionType: 'tts-synthesize', nodeId: 'tts-1' }`；PipelineNodeType 枚举 |
| `pages/editor/hooks/usePipelineResultMapper.ts` | 162* | 管线结果映射：TTS 结果 (nodeResult.shots) → store.setTtsResults |
| `shared/types/entities/editor.ts` | 59* | TtsResult / ScriptParagraph 类型定义 |

> `*` 表示文件内仅部分内容与 TTS 相关，非全量 TTS 代码。

**前端 TTS 总览：10 个文件，纯 TTS 代码约 302 行（StepTTSSynthesis + View + TTSParser），联合依赖约 740 行。**

### 1.2 后端（main/）

| 文件 | 行数 | 角色 |
|---|---|---|
| `engine/strategies/TTSStrategy.ts` | 164 | Step4 管线节点策略：并发控制、逐段合成、进度回调、结果统计 |
| `engine/capabilities/TTSProvider.ts` | 167 | TTS 能力提供者：5 种引擎实现 (doubao/edge/fish/sovits/moss) + 缓存 + 降级链 |
| `engine/AIEngine.ts` | ~80* | `generateTTS()` 静态方法：引擎路由、文本清洗、API 调用、文件落盘 |
| `controllers/EngineController.ts` | ~86* | IPC 注册：voice:preview / voice:listByEngine / voice:get-cloned-voices / voice:delete-cloned + getVoicesForEngine() |
| `controllers/AIController.ts` | ~98* | IPC 注册：voice:preview / voice:listByEngine / voice:get-cloned-voices / voice:clone（重复注册，存在双份 handler） |
| `services/AIService.ts` | ~50* | TTS 服务方法：testTTS / runSingleTTS / runGlobalTTS |
| `infra/ipc/IpcConstants.ts` | 220* | IPC 通道常量：VOICE_PREVIEW / VOICE_LIST_BY_ENGINE |

> `*` 表示文件内仅部分内容与 TTS 相关。

**后端 TTS 总览：7 个文件，纯 TTS 代码约 645 行（TTSStrategy + TTSProvider + AIEngine.generateTTS）。**

---

## 2. 依赖分析

### 2.1 外部依赖

| 依赖 | 来源 | 说明 |
|---|---|---|
| `zustand` | npm | 前端状态管理库，editorSlice 基于 zustand StateCreator |
| `lucide-react` | npm | 图标库 (Play, Square, Volume2, Mic, User) |
| `electron` (ipcMain) | Electron | 主进程 IPC 通信 |
| `crypto` | Node.js | 缓存 hash 生成 |
| `fs / path / os` | Node.js | 文件读写、路径、临时目录 |
| `react` | npm | UI 框架 |
| 火山引擎 API | `https://openspeech.bytedance.com/api/v1/tts` | doubao TTS |
| Edge TTS API | `https://api.tts.quest/v3/voicemaker` | 免费 Edge TTS |
| Fish Audio API | `https://api.fish.audio/v1/tts` | Fish Audio TTS |
| SoVITS 本地服务 | `http://127.0.0.1:9880` | 本地 SoVITS 服务 |
| MOSS-TTS 本地服务 | `http://127.0.0.1:9881` | 本地 MOSS-TTS-Nano 服务 |

### 2.2 内部依赖（调用关系图）

```
StepTTSSynthesis.tsx (智能组件)
  ├─ useStore()                          → editorSlice (ttsEngine, ttsVoiceId, ...)
  ├─ API.voice.preview()                 → IPC → EngineController / AIController
  ├─ API.voice.listByEngine()            → IPC → getVoicesForEngine()
  ├─ API.voice.getClonedVoices()         → IPC → LocalAiGateway
  ├─ API.engine.runPipeline()            → IPC → EngineController → TTSStrategy
  ├─ mapPipelineResultToState()          → usePipelineResultMapper → store.setTtsResults
  ├─ STEP_SEQUENCES[4]                   → pipelineConstants
  └─ StepTTSSynthesisView                → 纯展示组件

StepTTSSynthesisView.tsx (展示组件)
  ├─ VoiceCard                           → shared component
  ├─ Badge, Progress, StatHeader, EmptyState → shared components
  └─ ScriptParagraph, TtsResult          → shared/types/entities/editor

TTSStrategy.ts (后端策略)
  ├─ AIEngine.generateTTS()              → engine/AIEngine
  ├─ ProviderManager.getTTSConfig()      → engine/config
  └─ BaseNodeStrategy                    → 基类

TTSProvider.ts (后端能力)
  ├─ ProviderManager.getTTSConfig()      → engine/config
  └─ PathManager.getTTSOutputDir()       → utils/pathManager

AIEngine.generateTTS() [与 TTSProvider.synthesize() 代码重复]
  ├─ ProviderManager.getTTSConfig()      → engine/config
  └─ 5 种引擎 switch-case

EngineController / AIController
  ├─ TTSProvider                         → 音色预览
  ├─ getVoicesForEngine()                → 音色列表
  └─ LocalAiGateway                      → 克隆音色
```

### 2.3 关键发现

| 被依赖方 | 消费者 | 说明 |
|---|---|---|
| `editorSlice.ts` | `StepTTSSynthesis.tsx` | TTS 状态读写（引擎/音色/进度/结果） |
| `editorSlice.ts` | `usePipelineResultMapper.ts` | 管线结果写入 `store.setTtsResults()` |
| `API.voice.preview` | `StepTTSSynthesis.tsx` | 音色试听 |
| `API.voice.listByEngine` | `StepTTSSynthesis.tsx` | 动态获取 MOSS 音色列表 |
| `API.engine.runPipeline` | `StepTTSSynthesis.tsx` | 触发 step4 管线执行 |
| `TTSStrategy.ts` | `EngineController` (runPipeline) | 管线节点策略注册 |
| `TTSProvider.ts` | `EngineController` / `AIController` | 音色预览合成 |
| `AIEngine.generateTTS()` | `TTSStrategy.ts` / `AIController.ts` / `AIService.ts` | 实际 TTS 合成调用 |
| `IpcConstants.ts` | `api/index.ts` | IPC 通道常量引用 |

---

## 3. 各文件功能摘要

### 3.1 StepTTSSynthesis.tsx
**核心功能**：Step4 智能容器组件
- 管理引擎/音色状态，维护 5 种引擎的静态音色表 (VOICE_OPTIONS)
- 动态获取 MOSS 在线音色和 SoVITS/Fish 克隆音色
- 音色试听 (handleVoicePreview)：调用 `API.voice.preview`，播放返回的音频
- 合成触发 (handleSynthesize)：构造 `STEP_SEQUENCES[4]` 序列 → `API.engine.runPipeline`
- 结果预览：逐段播放合成后的音频
**导出**：`StepTTSSynthesis` (React.FC)
**关键依赖**：`useStore` (zustand), `API.voice`, `API.engine`, `mapPipelineResultToState`, `STEP_SEQUENCES`

### 3.2 StepTTSSynthesisView.tsx
**核心功能**：Step4 纯展示组件
- 引擎选择区（5 种引擎 Badge 切换）
- 音色选择网格（VoiceCard 组件）
- 语速滑块（0.5x ~ 2.0x）
- 合成进度条
- 配音结果列表（逐段预览/播放）
- 合成按钮
**导出**：`StepTTSSynthesisView`, `TtsVoiceOption` 类型
**关键依赖**：`VoiceCard`, `Badge`, `Progress`, `ScriptParagraph`, `TtsResult`

### 3.3 TTSParser.ts
**核心功能**：DAG 工作流中的 TTS 节点解析器
- 实现 `INodeParser` 接口
- 将 DAG 节点转为 `PipelineTask { actionType: 'tts-synthesize' }`
**导出**：`TTSParser` (class)
**行数**：20 行

### 3.4 storeTypes.ts (EditorSlice 中的 TTS 部分)
**核心功能**：TypeScript 类型定义
- `EditorSlice` 接口定义 TTS 字段：
  - `ttsEngine: string` — TTS 引擎名
  - `ttsVoiceId: string` — 当前音色 ID
  - `ttsProgress: number` — 合成进度 (0-100)
  - `ttsResults: TtsResult[]` — 合成结果数组
- 对应 action: `setTtsEngine`, `setTtsVoiceId`, `setTtsProgress`, `setTtsResults`

### 3.5 editorSlice.ts (TTS 部分)
**核心功能**：zustand 状态切片实现
- 默认值：`ttsEngine: 'edge'`, `ttsVoiceId: ''`, `ttsProgress: 0`, `ttsResults: []`
- `setTtsEngine` 切换引擎时自动清空 `ttsVoiceId`
- 4 个 setter 均为简单 `set()` 操作

### 3.6 api/index.ts (voice / engine API)
**核心功能**：前端 IPC 调用封装
- `API.voice.preview(provider, voiceId?, text?)` → `voice:preview`
- `API.voice.listByEngine(engine)` → `voice:listByEngine`
- `API.voice.getClonedVoices()` → `voice:get-cloned-voices`
- `API.engine.runPipeline(payload)` → `engine:run-pipeline`

### 3.7 TTSStrategy.ts
**核心功能**：Step4 管线节点执行策略
- `nodeType = 'tts-synthesize'`, `isRecoverable = true`
- `performTask()` 主流程：
  1. 从 input 读取引擎/音色（优先前端传入 → ProviderManager 配置 → 默认 edge）
  2. 收集待合成段落（优先 `input.scriptShots` → `context.bus` 上游 script-gen）
  3. 按引擎并发数 `runConcurrent()` 批量合成
  4. 进度回调（每完成一段更新百分比）
  5. 返回 `{ shots: TTSItemResult[], provider, successCount, failCount }`
- 并发策略：edge(6), doubao(5), fish(5), moss(2), sovits(2)
**导出**：`TTSStrategy` (class extends BaseNodeStrategy)

### 3.8 TTSProvider.ts
**核心功能**：TTS 能力提供者（独立封装）
- 5 种引擎实现：doubao / edge / fish / sovits / moss
- 文本清洗（去舞台标记）
- MD5 缓存：相同文本+引擎+音色复用结果
- `synthesizeWithFallback()`：Edge → MOSS → Fish 三级降级链
**导出**：`TTSProvider` (class), `TTSVendor` (type)

### 3.9 AIEngine.generateTTS()
**核心功能**：AIEngine 静态方法，与 TTSProvider.synthesize 代码高度重复
- 同样 5 种引擎 switch-case
- 无缓存逻辑，无降级链
- 被 TTSStrategy / AIController / AIService 三处调用
**状态**：应与 TTSProvider 合并消除重复

### 3.10 EngineController.ts (voice handlers)
**注册的 IPC handlers**：
- `voice:preview` → TTSProvider.synthesize
- `voice:listByEngine` → getVoicesForEngine()
- `voice:get-cloned-voices` → LocalAiGateway
- `voice:delete-cloned` → LocalAiGateway
- `role:updateVoice` → RoleRepository

### 3.11 AIController.ts (voice handlers — 重复注册)
**注册的 IPC handlers**（与 EngineController 重复）：
- `voice:clone` → 本地克隆流程
- `voice:preview` → AIEngine.generateTTS（与 EngineController 版本实现不同）
- `voice:listByEngine` → 内联 HARDCODED_VOICES + MOSS 在线查询
- `voice:get-cloned-voices` → 本地文件系统扫描

### 3.12 AIService.ts (TTS 部分)
**TTS 方法**：
- `testTTS(provider)` → AIEngine.generateTTS('测试语音', ...)
- `runSingleTTS(projectId, shot)` → 单段合成
- `runGlobalTTS(projectId, shots)` → 串行批量合成（非并发）
**状态**：这些方法似乎未被当前 step4 流程使用，由 TTSStrategy 替代

---

## 4. 架构评估

### 4.1 TTS 合成数据流

```
前端 StepTTSSynthesis
  │ API.engine.runPipeline({ sequence: [{ actionType: 'tts-synthesize', ... }] })
  ▼
IPC: engine:run-pipeline
  │
  ▼
EngineController → PipelineEngine → TTSStrategy.performTask()
  │ 1. 收集 scriptShots 或从 context.bus 读上游
  │ 2. 按引擎并发数 batch execute
  │ 3. 每个 shot → AIEngine.generateTTS(text, provider, cacheDir, voiceId)
  │     ├─ doubao → 火山引擎 API
  │     ├─ edge   → api.tts.quest (免费)
  │     ├─ fish   → Fish Audio API
  │     ├─ sovits → 本地 http://127.0.0.1:9880
  │     └─ moss   → 本地 http://127.0.0.1:9881
  │ 4. 返回 { shots: [{ shotId, audioPath, _failed }] }
  ▼
PipelineResult → mapPipelineResultToState()
  │ nodeType = 'tts' → store.setTtsResults([...])
  │ audioPath → magic://local/ URL 转换
  ▼
StepTTSSynthesisView 渲染结果列表
```

### 4.2 音色试听数据流

```
前端 StepTTSSynthesis.handleVoicePreview()
  │ API.voice.preview(engine, voiceId, previewText)
  ▼
IPC: voice:preview
  │
  ├─ EngineController 版本: TTSProvider.synthesize(text, provider, undefined, voiceId)
  └─ AIController 版本: AIEngine.generateTTS(text, provider, undefined, voiceId)
  │
  ▼
返回 { audioPath }
  │ magic://local/ URL 转换
  ▼
new Audio(url).play()
```

> **注意**：`voice:preview` 在两个 Controller 中重复注册，`IpcRouter.handle()` 内部会 `ipcMain.removeHandler(channel)` 后再注册，因此后注册的会覆盖先注册的。

---

## 5. 迁移评估

### 5.1 统计数据

| 指标 | 数值 |
|---|---|
| 前端 TTS 相关文件数 | 10 |
| 前端纯 TTS 代码行数 | ~302 (StepTTSSynthesis + View + TTSParser) |
| 前端联合依赖行数 | ~740 (store + api + types + pipeline 集成) |
| 后端 TTS 相关文件数 | 7 |
| 后端纯 TTS 代码行数 | ~645 (TTSStrategy + TTSProvider + AIEngine TTS + handlers) |
| 后端联合依赖行数 | ~200 (IpcConstants + Router) |
| 全局依赖数（IPC 通道） | 4 (`voice:preview`, `voice:listByEngine`, `voice:get-cloned-voices`, `engine:run-pipeline`) |
| Shared 类型依赖 | TtsResult, ScriptParagraph (来自 `shared/types/entities/editor.ts`) |

### 5.2 迁移方案建议

**目标目录**: `src/modules/pipeline/step4-tts/`

建议模块结构：
```
src/modules/pipeline/step4-tts/
├── index.ts                      # 模块导出
├── types.ts                      # TtsResult, TtsVoiceOption, TTSVendor 等类型
├── frontend/
│   ├── StepTTSSynthesis.tsx      # 智能组件（从 pages/editor 迁出）
│   ├── StepTTSSynthesisView.tsx  # 展示组件
│   └── hooks/
│       └── useTtsSynthesis.ts    # 新：提取 TTS 合成逻辑 hook
├── backend/
│   ├── TTSStrategy.ts            # 管线节点策略
│   ├── TTSProvider.ts            # TTS 能力提供者
│   └── AITTSProvider.ts          # 新：合并 AIEngine.generateTTS + TTSProvider
└── shared/
    └── voice-handlers.ts         # IPC handler 注册（合并 EngineController + AIController 重复逻辑）
```

**迁移优先级**：
1. **P0** — 合并 `AIEngine.generateTTS()` 与 `TTSProvider.synthesize()`，消除代码重复
2. **P0** — 合并 `EngineController` 与 `AIController` 中的 voice handler 重复注册
3. **P1** — 将 `StepTTSSynthesis.tsx` + `StepTTSSynthesisView.tsx` 迁入模块
4. **P1** — 将 `TTSStrategy.ts` + `TTSProvider.ts` 迁入模块
5. **P2** — 提取 `useTtsSynthesis` hook 解耦组件与 store
6. **P2** — 将 `TTSParser.ts` 迁入模块

### 5.3 风险评估

| 风险项 | 等级 | 说明 |
|---|---|---|
| AIEngine.generateTTS 与 TTSProvider.synthesize 代码重复 | 🟡 中 | 两处维护相同逻辑，修改需同步，容易遗漏 |
| voice:preview 双 Controller 重复注册 | 🟡 中 | 后注册覆盖先注册，行为取决于 Controller 加载顺序 |
| AIController 与 EngineController 中 getVoicesForEngine 逻辑不一致 | 🟡 中 | AIController 有额外音色 + HARDCODED_VOICES 独立定义，EngineController 音色更完整 |
| StepTTSSynthesis 与 store 紧耦合 | 🟡 中 | 组件直接使用 useStore 读取 12+ 个状态字段，迁移需同步更新引用 |
| TTSProvider 缓存基于 MD5 | 🟢 低 | 缓存键 = 文本+引擎+音色，合理但需注意清理策略 |
| 前端 VOICE_OPTIONS 硬编码 | 🟢 低 | 非 MOSS 引擎音色完全前端硬编码，与后端返回可能不一致 |
| Step4 管线节点依赖上游 script-gen | 🟡 中 | 若 context.bus 中无 script-gen 结果，TTSStrategy 返回空，前端需友好提示 |
| IpcConstants 重导出层 | 🟢 低 | `shared/utils/IpcConstants.ts` → `infra/ipc/IpcConstants.ts` 多一层跳转 |

---

## 6. 附录：IPC 通道清单

| 通道名 | 常量 | 注册位置 | 状态 |
|---|---|---|---|
| `voice:preview` | `VOICE_PREVIEW` | EngineController + AIController | ⚠️ 重复注册 |
| `voice:listByEngine` | `VOICE_LIST_BY_ENGINE` | EngineController + AIController | ⚠️ 重复注册 |
| `voice:get-cloned-voices` | — (字符串字面量) | EngineController + AIController | ⚠️ 重复注册 |
| `voice:delete-cloned` | — (字符串字面量) | EngineController | ✅ 唯一 |
| `voice:clone` | — (字符串字面量) | AIController | ✅ 唯一 |
| `engine:run-pipeline` | `ENGINE_RUN_PIPELINE` | EngineController | ✅ 唯一 |
| `role:updateVoice` | `ROLE_UPDATE_VOICE` | EngineController | ✅ 唯一 |
| `ai:testTTS` | `AI_TEST_TTS` | AIController | ✅ 唯一 |
| `ai:generateTTS` | `AI_GENERATE_TTS` | — (已弃用) | ❌ 未注册 |
| `ai:runSingleTTS` | `AI_RUN_SINGLE_TTS` | — (已弃用) | ❌ 未注册 |
| `ai:runGlobalTTS` | `AI_RUN_GLOBAL_TTS` | — (已弃用) | ❌ 未注册 |

---

## 7. 已被替代/弃用的代码

| 文件/方法 | 状态 | 替代者 |
|---|---|---|
| `AIService.runSingleTTS()` | 未使用 | TTSStrategy |
| `AIService.runGlobalTTS()` | 未使用 | TTSStrategy |
| `AIEngine.generateTTS()` | 代码重复 | TTSProvider.synthesize() |
| IPC: `ai:generateTTS` / `ai:runSingleTTS` / `ai:runGlobalTTS` | 未注册 handler | engine:run-pipeline |

---

## 8. 迁移完成记录

**迁移日期**: 2026-07-04  
**验证状态**: `tsc --noEmit` 通过 (RC=0, 零错误)

### 迁移文件清单

| 新位置 | 来源 | 状态 |
|---|---|---|
| `src/modules/pipeline/step4-tts/types.ts` | 架构文档 §3.3.5 定义 | 已创建 |
| `src/modules/pipeline/step4-tts/index.ts` | 新建 | 已创建（导出 types） |
| `src/modules/pipeline/step4-tts/frontend/Container.tsx` | `StepTTSSynthesis.tsx` | 已迁移 |
| `src/modules/pipeline/step4-tts/frontend/View.tsx` | `StepTTSSynthesisView.tsx` | 已迁移 |
| `src/modules/pipeline/step4-tts/backend/Strategy.ts` | `TTSStrategy.ts` | 已迁移 |
| `src/modules/pipeline/step4-tts/backend/Service.ts` | `TTSProvider.ts` | 已迁移 |

### 旧文件处理（@deprecated 重导出）

| 旧路径 | 操作 |
|---|---|
| `renderer/.../steps/StepTTSSynthesis.tsx` | 改为 re-export → `Container.tsx` |
| `renderer/.../containers/StepTTSSynthesisView.tsx` | 改为 re-export → `View.tsx` |
| `main/engine/strategies/TTSStrategy.ts` | 改为 re-export → `backend/Strategy.ts` |
| `main/engine/capabilities/TTSProvider.ts` | 改为 re-export → `backend/Service.ts` |

### 消费者导入路径更新

| 文件 | 变更 |
|---|---|
| `PipelineEngine.ts` | `./strategies/TTSStrategy` → `../../modules/pipeline/step4-tts/backend/Strategy` |
| `SimplePipelineRunner.ts` | `./strategies/TTSStrategy` → `../../modules/pipeline/step4-tts/backend/Strategy` |
| `AIEngine.ts` | `./capabilities/TTSProvider` → `../../modules/pipeline/step4-tts/backend/Service` |
| `EngineController.ts` | `../engine/capabilities/TTSProvider` → `../../modules/pipeline/step4-tts/backend/Service` |
| `capabilities/index.ts` | 更新重导出指向 Service.ts |
| `StepPanel.tsx` | `./steps/StepTTSSynthesis` → `../../../../../modules/pipeline/step4-tts/frontend/Container` |

### types.ts 修复

- 将 `import type { ScriptParagraph }` 从文件末尾移至顶部（修复 TypeScript import 位置规范）
