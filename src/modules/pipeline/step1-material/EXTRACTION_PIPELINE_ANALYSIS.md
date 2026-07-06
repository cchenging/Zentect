# ExtractionPipeline 新旧统一方案

> **生成日期**: 2026-07-05
> **目标**: 深度分析两套管线引擎差异，给出统一迁移方案

---

## 1. 两套引擎概览

### 1.1 旧版 ExtractionPipeline

| 维度 | 详情 |
|------|------|
| 文件 | `src/main/engine/ExtractionPipeline.ts` |
| 行数 | 308 |
| 架构模式 | 传统 Class + 硬编码步骤序列 |
| 构造函数 | `constructor(textExtractor: ITextExtractor)` |
| 核心方法 | `execute(filePath, mediaDir, framesDir, mediaId, projectId, ...)` |
| 唯一调用方 | `JobScheduler.ts` (line 123) |

### 1.2 新版 PipelineEngine

| 维度 | 详情 |
|------|------|
| 文件 | `src/main/engine/PipelineEngine.ts` |
| 行数 | 455 |
| 架构模式 | 策略模式 + 注册表 + DAG 拓扑排序 |
| 构造函数 | `constructor()` — 内部注册 9 个策略 |
| 核心方法 | `execute()` / `executePipeline()` / `executeFromWorkflow()` |
| 调用方 | `EngineController` (IPC), `AIService`, `BatchQueueEngine` |

### 1.3 Step1MaterialStrategy 骨架

| 维度 | 详情 |
|------|------|
| 文件 | `src/modules/pipeline/step1-material/backend/Strategy.ts` |
| 行数 | 64 |
| 状态 | **空壳** — `performTask()` 仅返回空 `results`，无任何真实算力调用 |
| 注释 | "帧提取由 consumer (ExtractionPipeline/AIEngine) 在策略外部处理" |

---

## 2. 调用方分析

### 2.1 旧版 ExtractionPipeline 调用链

```
用户导入素材
  → usePipelineOrchestrator.startCurrentStep()  (前端)
    → API.media.process(projectId, activeMedia, config)
      → IPC: media:process
        → JobScheduler.addExtractionJob()
          → new ExtractionPipeline(whisperStrategy)
            → pipeline.execute(filePath, mediaDir, framesDir, ...)
```

**JobScheduler 职责**（不只是调度器，也是 ExtractionPipeline 的唯一消费者）：
- 管理任务队列（入队、出队、失败重试）
- 构造 `ExtractionPipeline` 实例
- 处理进度回调 → 更新 DB + IPC 通知
- 处理结果 → 更新 Media DB + 路径转换 + 广播成功事件
- 线性快速管线（`executeLinearQuickPipeline`）—— 直连 Python 后台

### 2.2 新版 PipelineEngine 调用链

```
EngineController (IPC 层):
  ENGINE_RUN_PIPELINE  → new PipelineEngine().executePipeline(payload, callback)
  ENGINE_RUN_DAG_WORKFLOW → new PipelineEngine().executeFromWorkflow(projectId, callback)

AIService:
  this.pipelineEngine = new PipelineEngine()  (构造函数中创建)
  → 用于管线执行

BatchQueueEngine:
  private async executeDagPipeline(job) {
    const engine = new PipelineEngine();
    await engine.executeFromWorkflow(job.projectId, callback);
  }
```

### 2.3 调用方汇总表

| 引擎 | 调用方 | 触发场景 | 使用模式 |
|------|--------|----------|----------|
| ExtractionPipeline | JobScheduler | 素材导入后自动触发 | 每次 `new` 实例，单体执行 |
| PipelineEngine | EngineController | 用户点击步骤执行 / DAG工作流 | 每次 `new` 实例，支持序列/DAG |
| PipelineEngine | AIService | 构造函数中创建单例 | 长期持有实例 |
| PipelineEngine | BatchQueueEngine | 批量渲染队列中的 DAG 步骤 | 每次 `new` 实例 |

---

## 3. 差异对比分析

### 3.1 架构模式

| 维度 | ExtractionPipeline (旧) | PipelineEngine (新) |
|------|--------------------------|---------------------|
| 设计模式 | 单体 Class | 策略模式 + 注册表 |
| 扩展性 | 修改源代码，新增步骤需改动 `execute()` | OCP：新增策略类 + 一行注册 |
| 节点发现 | 硬编码步骤序列 | `strategyRegistry` Map，按 `nodeType` 动态路由 |
| 数据传递 | 局部变量（`validFrames` / `whisperResult` 等） | `ExecutionContext.bus`（共享 Map） |
| 状态管理 | 实例字段（`onProgressCallback` / `abortSignal` 等） | `EngineStateGuard` 全局互斥锁 |

### 3.2 步骤调度

| 维度 | ExtractionPipeline (旧) | PipelineEngine (新) |
|------|--------------------------|---------------------|
| 调度方式 | 固定顺序执行 | 序列模式（有序）或 DAG 模式（拓扑排序） |
| 并行能力 | `Promise.all` 双子星（抽帧 ∥ 音频分离） | DAG 同批次节点 `Promise.all` 并行 |
| 调度粒度 | 整个管线一条 `execute()` | 每个节点独立调度，`executeNodeTask()` |
| 前置依赖 | 无（硬编码顺序） | DAG 模式依赖 `edges` 拓扑排序 |

### 3.3 错误处理

| 维度 | ExtractionPipeline (旧) | PipelineEngine (新) |
|------|--------------------------|---------------------|
| 策略 | 逐步骤 try/catch，失败后 `warn` 日志 + 继续 | 两层：`performTask` 内 catch + `isRecoverable` 降级 |
| 降级 | 全部隐式降级（失败不阻断管线） | 显式 `isRecoverable` flag，返回 `_failed` 标记 |
| 异常归一化 | 无，直接抛出原始错误 | `ExceptionHub.normalize()` → I18N Key 契约 |
| 熔断 | `AbortSignal` 检查 | `abort()` + `EngineStateGuard.forceReset()` |

### 3.4 进度上报

| 维度 | ExtractionPipeline (旧) | PipelineEngine (新) |
|------|--------------------------|---------------------|
| 契约 | `(percent: number, text: string) => void` | `(progressData: TaskProgressPayload) => void` |
| 结构 | 扁平，`(20, 'extracting_frames')` | 结构化 `{nodeId, progress, status, message, results}` |
| 粒度 | 全管线级别（0→100） | 节点级别（每个节点独立 0→100） |
| 故事板通道 | 无 | `shot-data` 状态推送 shotId 卡片数据 |

### 3.5 IPC 通信

| 维度 | ExtractionPipeline (旧) | PipelineEngine (新) |
|------|--------------------------|---------------------|
| 通信方 | JobScheduler 中转（`MainNotifier`） | EngineController 直接处理 |
| 通道 | `IPC_CHANNELS.EVENT_EXTRACTION_SUCCESS` 等 | `IPC_CHANNELS.ENGINE_PIPELINE_PROGRESS` |
| 解耦 | 引擎不感知 IPC | `execute()` 接收 `WebContents`，`executePipeline()` 通过回调 |

### 3.6 管线步骤覆盖对比

| 步骤 | ExtractionPipeline | PipelineEngine 对应策略 |
|------|-------------------|------------------------|
| 抽帧 | `VideoProcessor.extractFrames()` 内联 | `VisionExtractStrategy` (nodeType: `vision-extract`) |
| 音频分离 | `AudioProcessor.separateAudio()` + Demucs 人声分离 | `AudioSeparateStrategy` (nodeType: `audio-separate`) |
| ASR 识别 | `textExtractor.transcribe()` (SenseVoice/Whisper) | `ASRStrategy` (nodeType: `asr`) → 委托 `LocalWhisperStrategy` |
| 人脸检测 | `VisionProcessor.scanFaces()` | `FaceDetectStrategy` (nodeType: `face-detect`) |
| 人脸聚类 | `VisionProcessor.clusterFaces()` (HDBSCAN) | **无** |
| 聚类注入镜头 | `clustersMap` → `shot.clusterIds` | **无** |
| CLIP 语义提取 | `VisionProcessor.extractSemantics()` | **无** |
| 语义流生成 | `VisionProcessor.generateSemanticFlow()` | **无** |
| 数据组装 | `MediaEngine.assemblePipelineData()` | **无** (由前端 consuming 策略结果) |
| 白屏保护 | 空 shots → 插入 fallback shot | **无** |
| 抽帧降级回退 | VLM/scene <3帧 → UNIFORM_FPS | **无** |

---

## 4. 旧版独有功能清单

以下功能存在于 `ExtractionPipeline` 但新版 `PipelineEngine` 尚未覆盖：

### 4.1 双子星并行调度（帧+音频同时启动）

```typescript
// ExtractionPipeline L82-161
const [_frameResult, _audioResult] = await Promise.all([
    (async () => { /* 抽帧 */ })(),
    (async () => { /* 音频分离 */ })()
]);
```

新版引擎中，`VisionExtractStrategy` 和 `AudioSeparateStrategy` 各自独立，由 DAG/序列模式串行或同批次并行。但旧版使用 `Promise.all` 的明确双子星并行调度尚无等价物。

### 4.2 抽帧自动降级回退

```typescript
// ExtractionPipeline L100-119
const needsFallback = (strategy === 'VLM_OPTIMIZED' || strategy === 'scene')
    && telemetryResult.files.length < 3;
if (needsFallback) {
    // 自动降级到 UNIFORM_FPS 重抽
    telemetryResult = await VideoProcessor.extractFrames(filePath, framesDir, mediaId, {
        strategy: 'UNIFORM_FPS', fps: 2, ...
    });
}
```

`VisionExtractStrategy` 未实现此降级逻辑。

### 4.3 人脸聚类 + 反向注入镜头

```typescript
// ExtractionPipeline L195-215
roles = await VisionProcessor.scanFaces(validFrames, facesDir);
clustersMap = await VisionProcessor.clusterFaces(mediaId, roles);

// 反向注入：把 clusterId 写入每个 shot，为前端"一键找人"建立羁绊
assembledShots = assembledShots.map(shot => {
    const cid = clustersMap[frameName];
    return { ...shot, clusterIds: (cid && cid !== 'role_unknown') ? [cid] : [] };
});
```

`FaceDetectStrategy` 仅调 `/api/vision`，不涉及聚类和注入。

### 4.4 CLIP 语义提取 + Vision LLM 语义流

```typescript
// ExtractionPipeline L224-231
await VisionProcessor.extractSemantics(mediaId, assembledShots);
assembledShots = await VisionProcessor.generateSemanticFlow(assembledShots);
```

`SemanticAnalyzeStrategy` 做的是镜头匹配（解说词→视频片段 CLIP + 匈牙利算法），而非对已提取镜头的语义流生成。

### 4.5 白屏保护（空结果兜底）

```typescript
// ExtractionPipeline L212-216
if (assembledShots.length === 0) {
    assembledShots.push({
        id: `shot_${Date.now()}_0`, imagePath: '', text: '无可解析的内容', ...
    });
}
```

### 4.6 人脸角色归纳（role 去重 + 头像选择）

```typescript
// ExtractionPipeline L202-210
const finalRoles: any[] = [];
const processedClusters = new Set<string>();
for (const r of roles) {
    const cid = clustersMap[r.systemId] || 'role_unknown';
    if (cid !== 'role_unknown' && cid !== '-1' && !processedClusters.has(cid)) {
        processedClusters.add(cid);
        finalRoles.push({ id: `${mediaId}_${cid}`, systemId: cid, name: `角色_...`, avatar: r.avatarPath });
    }
}
```

---

## 5. 新版独有功能清单

以下功能仅存在于 `PipelineEngine`，旧版无：

| 功能 | 说明 |
|------|------|
| 策略注册表 | `strategyRegistry` Map，按 `nodeType` 动态路由，OCP 原则 |
| DAG 拓扑排序 | `executeFromWorkflow()` — 从 WorkflowService 加载节点/连线，Kahn 算法调度 |
| EngineStateGuard | 全局算力互斥锁，防止并发重叠执行 |
| ExceptionHub | 异常归一化为 I18N Key 契约，前后端统一 |
| R/S/T/P 管道参数 | 从 SettingsRepository 读取，注入 ExecutionContext |
| L2 缓存探针 | `probeCache()` — 静默检查缓存，不执行真实算力 |
| Recoverable 降级 | `isRecoverable` flag + `_failed` 标记，策略级降级决策 |
| shot-data 故事板通道 | 进度为 100 且包含 `shotId` 时推送到故事板卡片 |
| 节点模型配置 | 从 `pipeline_model_config` 表按节点类型查询模型 |
| 工作流持久化 | WorkflowService.save/load，SQLite 存取 DAG |

---

## 6. 统一方案

### 6.1 推荐方案：阶段性收敛

建议分两阶段执行，不追求一次性全部替换。

#### 阶段一（短期，1-2 天）：消除 Step1MaterialStrategy 空壳

**现状**：`Step1MaterialStrategy.performTask()` 是空壳，仅返回空 `results`。

**方案**：Step1MaterialStrategy 不做"真实算力执行"，而是作为管线注册入口，将子步骤委托给 PipelineEngine 的独立策略（VisionExtractStrategy / AudioSeparateStrategy / ASRStrategy / FaceDetectStrategy）。

**改动文件**：

| 文件 | 改动 |
|------|------|
| `step1-material/backend/Strategy.ts` | 重构 `performTask`：不再返回空对象，改为调用 PipelineEngine 执行子序列 |
| `step1-material/types.ts` | 保持 Step1Input/Step1Output 不变 |

**收益**：消除"策略骨架"的技术债，让 Step1MaterialStrategy 真正发挥作用。

#### 阶段二（中期，3-4 天）：将旧版独有能力迁移到策略

**任务**：将 §4 列出的旧版独有能力拆分为独立策略或增强现有策略。

| 旧版功能 | 迁移目标 | 方式 |
|----------|----------|------|
| 双子星并行 | PipelineEngine DAG 模式 | 在 DAG 中将 vision-extract 和 audio-separate 设为同批次并行节点 |
| 抽帧降级回退 | 增强 VisionExtractStrategy | 在 `performTask` 中加入帧数检测 + UNIFORM_FPS 回退 |
| 人脸聚类 | 新建 ClusterFacesStrategy | nodeType: `cluster-faces`，封装 HDBSCAN |
| 聚类注入镜头 | 增强现有组装逻辑 | 在 DAG 末尾增加后处理节点 |
| CLIP 语义提取 | 新建 ClipSemanticStrategy | nodeType: `clip-semantic` |
| 语义流生成 | 新建 SemanticFlowStrategy | nodeType: `semantic-flow`（与现有 SemanticAnalyzeStrategy 区分） |
| 白屏保护 | PipelineEngine 后处理 | 在 `executePipeline` 末尾增加空结果兜底 |
| 人脸角色归纳 | 增强 FaceDetectStrategy 或新建 | 在聚类完成后做去重+头像归纳 |

#### 阶段三（长期，1-2 天）：废弃旧版 ExtractionPipeline

**前置条件**：阶段二全部完成，且 PipelineEngine 能完整替代 JobScheduler 的媒体导入全流程。

**步骤**：
1. 将 `JobScheduler.processNext()` 中的 `new ExtractionPipeline(whisperStrategy)` 替换为 PipelineEngine 调用
2. 确保 `EVENT_EXTRACTION_SUCCESS` 事件格式兼容
3. 删除 `ExtractionPipeline.ts`
4. 清理 `pipelineConstants.ts` 中的 `CODE_TO_NAME` 旧版状态码映射

### 6.2 不改动范围

以下文件和架构保持不变：

| 保持项 | 原因 |
|--------|------|
| `SimplePipelineRunner` | 独立路径，用于固定7步骤管线（人机交替挂起模式），不参与本次统一 |
| `JobScheduler` 的 `executeLinearQuickPipeline` | 极速向导直连 Python 后台，不走管线引擎，独立路径 |
| `LocalWhisperStrategy` | 已被 ASRStrategy 委托，职责清晰，无需迁移 |
| `BaseNodeStrategy` | 策略基类，已有泛型约束 + 模型配置注入，无需修改 |

### 6.3 改动文件总清单

| 阶段 | 文件 | 操作 | 风险 |
|------|------|------|------|
| 一 | `step1-material/backend/Strategy.ts` | 重构 | 低 — 空壳改实装 |
| 二 | `VisionExtractStrategy.ts` | 增强（降级回退） | 中 — 涉及 FFmpeg 调用路径 |
| 二 | 新建 `ClusterFacesStrategy.ts` | 新建 | 低 — 全新策略 |
| 二 | 新建 `ClipSemanticStrategy.ts` | 新建 | 低 — 全新策略 |
| 二 | 新建 `SemanticFlowStrategy.ts` | 新建 | 低 — 全新策略 |
| 二 | `PipelineEngine.ts` | 注册新策略 | 低 — 加一行 register |
| 二 | `PipelineEngine.ts` | 增加白屏保护后处理 | 低 |
| 三 | `JobScheduler.ts` | 替换 ExtractionPipeline 调用 | 高 — 媒体导入核心路径 |
| 三 | `ExtractionPipeline.ts` | 删除 | 中 — 确认无残留引用 |
| 三 | `pipelineConstants.ts` | 清理旧版状态码映射 | 低 |

### 6.4 风险提示

1. **JobScheduler 依赖深度耦合**：`JobScheduler.processNext()` 不仅调用 ExtractionPipeline，还直接处理 MediaRepository 更新、路径相对化转换、hydratePayload。替换时需完整复刻这些逻辑。

2. **进度事件格式兼容**：旧版 `(percent, text)` 经由 `MainNotifier.notifyTaskProgress()` 发送；新版 `TaskProgressPayload` 通过 `ENGINE_PIPELINE_PROGRESS` 通道。前端 `usePipelineOrchestrator` 监听两套通道，需确保迁移后前端不被破坏。

3. **抽帧路径差异**：旧版帧目录由 `PathManager.getProjectExtractionsDir` 管理；新版通过 `PathManager.getNodeL2CacheDir`（含 hash）。合并时需统一路径策略。

4. **Step1MaterialStrategy 与 PipelineEngine 循环依赖**：如果 Strategy.ts 中引入 PipelineEngine，需注意模块加载顺序。建议通过依赖注入或延迟加载解决。
