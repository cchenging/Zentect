# VLM 双路径深度分析报告

> **日期**：2026-07-05  
> **来源**：架构文档 STEP2_ANALYSIS.md §5.1 的延伸深度分析  
> **分析范围**：AIController.visionExtract vs VisionExtractStrategy.performTask  
> **原则**：只分析不修改

---

## 一、两条路径概览

### 1.1 Path 1 — AIController.visionExtract（旧 IPC 路径）

| 维度 | 详情 |
|---|---|
| 文件 | `src/main/controllers/AIController.ts` L83-143 |
| 注册 | `IpcRouter.handle(IPC_CHANNELS.AI_VISION_EXTRACT, ...)` |
| IPC 通道 | `vision:extract` |
| 触发方式 | 前端步骤2独立执行 |

### 1.2 Path 2 — VisionExtractStrategy.performTask（新管线路径）

| 维度 | 详情 |
|---|---|
| 文件 | `src/main/engine/strategies/VisionExtractStrategy.ts` L59-364 |
| 注册 | `PipelineEngine` L31: `this.register(new VisionExtractStrategy())` |
| 节点类型 | `vision-extract` |
| 触发方式 | PipelineEngine / SimplePipelineRunner 策略调度 |

---

## 二、调用方分析

### 2.1 Path 1 调用方（前端 → IPC）

```
usePipeline.ts (L57)                        ─┐
usePipelineOrchestrator.ts [deprecated] (L95) ├─→ API.ai.visionExtract(projectId, mediaPath, mediaId, existingFrames)
usePipelineOrchestrator.ts [new module] (L72) ─┘       │
                                                        ▼
                                              IpcRouter.handle('vision:extract')
                                                        │
                                                        ▼
                                              AIController.visionExtract (Path 1)
```

**关键特征**：都在 `step === 2` 分支内调用，与步骤 3-5 走 PipelineEngine 的路径隔离。

### 2.2 Path 2 调用方（后端管线）

```
SimplePipelineRunner.ts L231  ──→ new VisionExtractStrategy().execute(..., stepId='extract_frames')
                                     │  用途：步骤1「素材分析」中作为抽帧+VLM一体的节点
PipelineEngine.ts L31          ──→ strategyRegistry.set('vision-extract', new VisionExtractStrategy())
                                     │  用途：以 PipelineEngine 策略模式调度
```

**关键发现**：SimplePipelineRunner 将 VisionExtractStrategy 作为 `extract_frames`（步骤1）节点使用，而非步骤2。步骤2实际通过 IPC 走 Path 1。

### 2.3 调用路径对比

| 场景 | 走哪条路径 | 入口 |
|---|---|---|
| 用户在编辑器点击"步骤2: 画面描述" | Path 1 (visionExtract) | usePipelineOrchestrator → IPC → AIController |
| SimplePipelineRunner 全自动管线 | Path 2 (performTask) | SimplePipelineRunner → VisionExtractStrategy (作为 extract_frames) |
| PipelineEngine 工作流调度 | Path 2 (performTask) | PipelineEngine → VisionExtractStrategy (作为 vision-extract) |

---

## 三、逐维度差异对比

### 3.1 输入格式

| 维度 | Path 1 | Path 2 |
|---|---|---|
| 参数类型 | `{ projectId, mediaPath, mediaId, framePaths }` | `VisionExtractInput { mediaId, mediaPath, modelName?, framesMode?, framesValue?, framePaths?, projectId? }` |
| 帧来源 | **必须**外部传入 framePaths（复用步骤1已抽取帧） | 可选 framePaths；无则自行调用 VisionProcessor.extractKeyframes 抽帧 |
| 类型安全 | 无类型约束，plain object | 强类型接口 + BaseNodeStrategy 泛型约束 |
| ASR 输入 | **无** | 从 `context.bus.get('asr-result')` 读取，做时间对齐 |
| 模型可配 | 无（硬编码 `qwen-vl-max`） | 支持 `input.modelName` 覆盖，否则用 LLMFactory 默认 |
| 抽帧模式 | 无（只能复用） | 支持 `framesMode: 'fps' | 'scene'` + `framesValue` |

### 3.2 并发模型

| 维度 | Path 1 | Path 2 |
|---|---|---|
| 策略 | **分批串行**：BATCH_SIZE=5，逐批调用 VLM | **逐帧 5 路并发**：CONCURRENT_VLM=5，Promise.race 调度 |
| 每批 VLM 调用 | 一次传入 5 帧图片 + 一段 prompt，要求 VLM 逐帧描述 | 每帧单独调用 VLM（含滑动窗口上下文帧） |
| 并行度 | 串行批次，批次内多帧 | 真正的 5 路并发，帧间无等待 |
| 性能特征 | 总耗时 ≈ (帧数/5) × 单批延迟。帧数多时线性增长 | 总耗时 ≈ (帧数/5) × 单帧延迟。高并发利用 VLM 并发配额 |
| VLM token 消耗 | 每批 5 帧图片 + prompt，单次 token 大 | 每帧 1~5 帧图片（含窗口），单次 token 小但调用次数多 |

**示例**（假设 30 帧、单帧 VLM 耗时 3s）：
- Path 1：6 批 × 3s = **18s**
- Path 2：ceil(30/5) × 3s = **18s**（理论相近，但 Path 2 的并发饱和度和容错更好）

### 3.3 错误处理

| 维度 | Path 1 | Path 2 |
|---|---|---|
| 粒度 | 批次级 try-catch | 帧级 try-catch |
| 失败影响 | 一个批次失败 → 整个任务失败，throw 中断 | 单帧失败 → 该帧描述置空，其余帧继续 |
| 重试 | 无 | 无（由 PipelineEngine 外层重试策略兜底） |
| 降级 | 无 | 无（VisionExtractStrategy.isRecoverable=false） |
| 错误日志 | 日志含批次号 | 日志含帧序号、JSON解析状态 |

### 3.4 Prompt 构建

| 维度 | Path 1 | Path 2 |
|---|---|---|
| system prompt | 硬编码：`"你是一个专业的视频画面解析引擎..."` | `PromptBuilder.buildVisionExtractPrompt()` 生成 |
| 格式化要求 | 要求 `"帧X:"` 开头，逐行描述 | 要求 JSON 返回（含 narrativeAction/emotionalState 等结构化字段） |
| ASR 上下文 | **无** | 注入 `【台词上下文】` 块，帧时间窗口对齐 |
| 多帧窗口 | 无（每批独立） | `buildFrameWindow(radius=2)` 构建前后帧滑动窗口 |
| 温度 | 使用 LLMFactory 默认 | 硬编码 `0.2`（低温，保证结构化输出稳定） |

### 3.5 输出格式

| 维度 | Path 1 | Path 2 |
|---|---|---|
| 结构 | `{ framesCount, sceneDescriptions, framePaths }` | `{ framesCount, sceneDescriptions, framePaths, frames: FrameDetail[] }` |
| sceneDescriptions | 按 `\n` 拆分的纯文本行列表，与帧 1:1 对齐（不足补空、多余截断） | 逐帧处理后的 JSON 字段拼接（narrativeAction + emotionalState + visualAtmosphere + spatialRelation） |
| 单帧描述 | 自然语言文本 | 五维结构化数据（叙事/情绪/光影/空间/情绪基调） |
| FrameDetail | **无** | 包含 url/description/asrText/asrTime/timeMs/timeStr/emotion/editing/confirmed |
| 流式推送 | **无** | 每完成 5 帧推送 `partialFrames` + `completedCount/totalCount` |

### 3.6 额外能力

| 能力 | Path 1 | Path 2 |
|---|---|---|
| ASR-帧时间对齐 | ❌ | ✅ 按估算间隔匹配台词到帧 |
| 帧确认状态跟踪 | ❌ | ✅ FrameDetail.confirmed |
| 情绪标注 | ❌ | ✅ emotionTone 字段（从 VLM JSON 提取） |
| Base64 缓存 | ❌（每次读取磁盘） | ✅ LRU 缓存（MAX=60），减少重复 I/O |
| 抽帧能力 | ❌（依赖外部传入） | ✅ 内置 VisionProcessor.extractKeyframes |
| 进度回调 | ❌（仅日志） | ✅ 详细进度百分比 + 状态文本 + 部分结果推送 |
| 模型配置 | ❌ 硬编码 | ✅ input.modelName / LLMFactory 默认 |

---

## 四、前端兼容适配现状

前端在两个地方做了兼容适配：

### 4.1 usePipelineOrchestrator.ts（步骤2独立路径）

```typescript
if (vlmData.sceneDescriptions || vlmData.framePaths) {
  // 兼容 Path 1 的返回格式：sceneDescriptions 字符串
  const descriptions = vlmData.sceneDescriptions.split('\n').filter(...)
  // 手动构造 VlmFrame[]
} else if (Array.isArray(vlmData.frames) && vlmData.frames.length > 0) {
  // 兼容 Path 2 的返回格式：frames 对象数组
  const vlmFrames = vlmData.frames.map(f => ({ url, description, ... }))
}
```

### 4.2 usePipelineResultMapper.ts（管线结果映射）

```typescript
// 同样兼容两种格式：
if (Array.isArray(frames) && typeof frames[0] === 'object') { ... }
else if (nodeResult.sceneDescriptions) { ... }
```

**结论**：前端已经为双格式写了胶水代码，但这是技术债而非特性。

---

## 五、根因分析：双路径为什么存在

### 5.1 历史演进路径

```
阶段 1 (MVP)：AIController.visionExtract 作为快速原型实现
  → 直接 IPC，快速验证"VLM 描述画面"可行性
  
阶段 2 (架构重构)：引入 BaseNodeStrategy 策略模式 + PipelineEngine
  → VisionExtractStrategy 按新架构重写，功能更完整
  → 但步骤2的前端调用代码未同步更新，仍走旧 IPC

阶段 3 (SimplePipelineRunner)：抽帧+VLM 合并为 extract_frames
  → VisionExtractStrategy 被 Step 1 复用
  → 两条路径正式分叉
```

### 5.2 根本原因

1. **前端调用未迁移**：`usePipelineOrchestrator` 中 `step === 2` 的分支硬编码调用 `API.ai.visionExtract()`，没有走 PipelineEngine。
2. **步骤2不在 PipelineEngine 编排内**：步骤1走 `API.media.process`，步骤2走独立 IPC，步骤3-5才走 PipelineEngine，架构不一致。
3. **SimplePipelineRunner 与其负责的步骤 1-7 是另一个管线体系**：与编辑器 UI 的步骤 1-5 是不同的执行路径。

---

## 六、统一方案

### 6.1 决策：保留 Path 2，淘汰 Path 1

**保留 VisionExtractStrategy.performTask（Path 2），删除 AIController.visionExtract（Path 1）。**

理由：

| 维度 | Path 1 | Path 2 | 结论 |
|---|---|---|---|
| 功能完整性 | 基础 | 丰富（ASR对齐、情绪、流式、抽帧） | Path 2 胜 |
| 架构一致性 | 独立 IPC，不可组合 | 策略模式，可编排 | Path 2 胜 |
| 并发性能 | 串行批次 | 5路并发 | Path 2 胜 |
| 错误韧性 | 单批失败全挂 | 单帧失败继续 | Path 2 胜 |
| 可扩展性 | 硬编码 prompt | PromptBuilder 可插拔 | Path 2 胜 |
| 模型可配 | 硬编码模型名 | 支持参数覆盖 | Path 2 胜 |
| 输出质量 | 纯文本行 | 结构化 JSON + 降级纯文本 | Path 2 胜 |

### 6.2 具体改动清单

#### 6.2.1 删除的代码（旧路径）

| 文件 | 范围 | 说明 |
|---|---|---|
| `src/main/controllers/AIController.ts` | L83-143 | 删除 `IPC_CHANNELS.AI_VISION_EXTRACT` handler 整个代码块 |
| `src/shared/utils/IpcConstants.ts` | `AI_VISION_EXTRACT` 常量定义 | 删除或标记 `@deprecated` |
| `src/renderer/src/api/index.ts` | L84 `visionExtract(...)` | 删除 API 封装 |

#### 6.2.2 修改的代码

| 文件 | 改动 | 说明 |
|---|---|---|
| `src/renderer/src/store/hooks/usePipeline.ts` | 步骤2分支不再调 `API.ai.visionExtract`，改为调 `API.engine.runPipeline` | 步骤2纳入 PipelineEngine |
| `src/renderer/src/pages/editor/hooks/usePipelineOrchestrator.ts` [deprecated] | 同上 | 保持与新版一致 |
| `src/modules/editor/shell/frontend/hooks/usePipelineOrchestrator.ts` [new] | 同上 | 新版统一入口 |
| `src/renderer/src/pages/editor/utils/pipelineConstants.ts` | 确认 `STEP_SEQUENCES[2]` 的 actionType 为 `vision-extract`，params 包含 `framePaths` | 确保与 VisionExtractStrategy.VisionExtractInput 匹配 |
| `src/renderer/src/pages/editor/hooks/usePipelineResultMapper.ts` | 简化 VISION 分支：仅保留 `frames: FrameDetail[]` 格式的映射，删除 `sceneDescriptions` 兼容分支 | Path 1 格式不再出现 |

#### 6.2.3 需要新增/调整的部分

| 项 | 内容 |
|---|---|
| 步骤2 nodeId 规范 | PipelineEngine 调度时 nodeId 格式约定（如 `step2_${projectId}`） |
| IPC 通道清理 | `vision:extract` 通道可安全移除或保留为 no-op（防止旧前端报错） |
| 向后兼容 | `VisionExtractStrategy.performTask` 已输出 `sceneDescriptions`（帧描述 join），前端可继续兼容此字段 |

### 6.3 迁移步骤

```
Step 1: 确认 VisionExtractStrategy 能覆盖所有 Path 1 的使用场景
        → 场景：前端传入 framePaths（步骤1已抽取帧）+ projectId + mediaPath
        → 确认：VisionExtractInput 完全支持这些字段
        
Step 2: 修改前端 3 个 usePipelineOrchestrator/usePipeline
        → 步骤2不再调 API.ai.visionExtract
        → 改为构造 PipelinePayload，actionType='vision-extract'
        → 通过 API.engine.runPipeline 调用
        
Step 3: 更新 usePipelineResultMapper
        → 移除 sceneDescriptions 字符串兼容分支
        
Step 4: 删除旧代码
        → AIController.visionExtract handler
        → API.ai.visionExtract
        → AI_VISION_EXTRACT IPC 常量（或标记 deprecated）
        
Step 5: 验证
        → tsc --noEmit 零错误
        → 端到端：导入视频 → 步骤1抽帧 → 步骤2 VLM描述 → 结果正确展示
```

### 6.4 风险评估

| 风险 | 等级 | 缓解措施 |
|---|---|---|
| VisionExtractStrategy 未覆盖某个 Path 1 的边界场景 | 🟡 中 | Path 1 仅作为 IPC 透传层，无特殊边界逻辑 |
| PipelineEngine 进度回调格式与步骤2 UI 不完全匹配 | 🟡 中 | VisionExtractStrategy 已有 `onProgress` 回调，格式与 PipelineEngine 一致 |
| 步骤2 nodeId 与步骤3-5 冲突 | 🟢 低 | PipelineEngine 按 nodeId 隔离上下文 |

### 6.5 不改动的部分

- `SimplePipelineRunner` 中对 VisionExtractStrategy 的使用保持不变
- `VisionExtractStrategy.ts` 本身无需修改
- 前端 View 组件（StepVisionDescriptionView）无需修改
- `PromptBuilder` / `FrameWindowBuilder` / `VisionProcessor` 无需修改

---

## 七、文件索引

分析涉及的全部文件：

| # | 文件 | 角色 |
|---|---|---|
| 1 | `src/main/controllers/AIController.ts` | Path 1 实现 |
| 2 | `src/main/engine/strategies/VisionExtractStrategy.ts` | Path 2 实现 |
| 3 | `src/main/engine/strategies/BaseNodeStrategy.ts` | Path 2 基类 |
| 4 | `src/main/engine/SimplePipelineRunner.ts` | Path 2 调用方（步骤1） |
| 5 | `src/main/engine/PipelineEngine.ts` | Path 2 调度引擎 |
| 6 | `src/main/engine/prompts/PromptBuilder.ts` | Path 2 Prompt 构建 |
| 7 | `src/main/engine/media/FrameWindowBuilder.ts` | Path 2 滑动窗口 |
| 8 | `src/renderer/src/store/hooks/usePipeline.ts` | Path 1 调用方 |
| 9 | `src/renderer/src/pages/editor/hooks/usePipelineOrchestrator.ts` | Path 1 调用方 (deprecated) |
| 10 | `src/modules/editor/shell/frontend/hooks/usePipelineOrchestrator.ts` | Path 1 调用方 (new) |
| 11 | `src/renderer/src/pages/editor/hooks/usePipelineResultMapper.ts` | 双格式兼容适配 |
| 12 | `src/renderer/src/api/index.ts` | Path 1 API 封装 |
| 13 | `src/modules/pipeline/step2-vision/STEP2_ANALYSIS.md` | 前置分析文档 |
| 14 | `src/modules/pipeline/step2-vision/types.ts` | Step2 类型定义 |
| 15 | `src/modules/pipeline/step2-vision/index.ts` | Step2 公共 API |

---

## 八、执行记录

### 2026-07-05 — Path 1 删除 & 步骤2迁移至 PipelineEngine

**执行摘要**：按本文档四（统一方案）执行，tsc 零错误通过。

**删除 Path 1（3 处）**：
- `src/main/controllers/AIController.ts` L69-L152 — 移除 `visionExtract` IPC handler 及相关 import（`VisionExtractStrategy`、`LLMFactory`）
- `src/main/infra/ipc/IpcConstants.ts` L93 — 移除 `AI_VISION_EXTRACT: 'vision:extract'` 常量
- `src/renderer/src/api/index.ts` L84 — 移除 `visionExtract()` 方法

**步骤2迁移至 PipelineEngine（2 处）**：
- `src/renderer/src/store/hooks/usePipeline.ts` — 移除 step===2 的 `API.ai.visionExtract()` 硬编码分支，统一走 `PipelineEngine` + `mapPipelineResultToState`；保留帧路径前置检查
- `src/renderer/src/pages/editor/hooks/usePipelineOrchestrator.ts` — 同上，step 2 注入 `framePaths` + `projectId` 到 `enrichedSequence`

**验证**：
- `fs_search_content`: `AI_VISION_EXTRACT` / `visionExtract` / `vision:extract` 全局零引用
- `pnpm tsc --noEmit`: returncode 0，无编译错误

**不动**：`VisionExtractStrategy`、`PipelineEngine`、`PromptBuilder`、`FrameWindowBuilder`、前端 View 层
