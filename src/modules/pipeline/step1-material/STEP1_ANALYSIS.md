# Step1-Material 迁移分析文档

> **生成日期**：2026-07-04
> **目标**：将 pipeline step1-material 模块按架构文档 (§3.3.2) 规格迁移到 `src/modules/pipeline/step1-material/`

---

## 1. 概述

### 1.1 当前状态

step1-material（素材分析）的功能代码当前分散在多个目录中，未按架构文档的模块化结构组织：

| 位置 | 内容 | 文件数 |
|------|------|--------|
| `src/renderer/src/pages/editor/components/steps/` | 前端容器与视图组件 | 2 |
| `src/renderer/src/pages/editor/components/steps/sub-steps/` | 4个子步骤独立组件 | 4 |
| `src/renderer/src/pages/editor/components/inspectors/configs/` | 抽帧配置面板 | 1 |
| `src/renderer/src/core/parsers/` | 3个节点解析器 | 3 |
| `src/main/engine/strategies/` | 4个后端策略 | 4 |
| `src/main/engine/` | 3个管线引擎（含旧版ExtractionPipeline） | 3 |
| `src/renderer/src/store/` | 2个Store（useStore + usePipelineStore） | 2 |
| `src/renderer/src/pages/editor/hooks/` | 管线编排器 + 结果映射器 | 2 |
| `src/shared/types/` | 实体类型 + 管线契约 | 2 |

**核心问题**：不在独立模块目录中，缺少 types.ts/index.ts 接口契约，Store 状态分散在两个 Store 中，前端直接依赖全局 Store，缺少 Repository 层。

### 1.2 架构文档规格摘要

| 维度 | 规格 |
|------|------|
| 功能 | 音频分离、ASR台词识别、关键帧抽取、人物识别 |
| 输入 | `Step1Input { projectId, mediaPath, config }` |
| 输出 | `Step1Output { asrLines, framePaths, frameCount, audioSeparated, roles }` |
| UI | 4个可折叠卡片（关键帧/音频/ASR/人脸），每卡片含状态指示+重试按钮 |
| Store | `Step1State { asrLines, frameCount, audioSeparated, roles, subStepStatuses, subStepProgresses, extractionConfig }` |
| 目录结构 | `types.ts / index.ts / frontend/ / backend/ / data/ / __tests__/` |

---

## 2. 源文件清单

### 2.1 前端组件（7个文件，共 526 行）

| 文件 | 行数 | 职责 | 位置 |
|------|------|------|------|
| `StepMaterialAnalysis.tsx` | 59 | 容器组件：从全局Store读状态，构造回调，传Props给View | `.../editor/components/steps/` |
| `StepMaterialAnalysisView.tsx` | 148 | 视图组件：4个CollapsibleCard，纯Props驱动 | `.../editor/components/steps/containers/` |
| `FrameExtractConfig.tsx` | 196 | 抽帧配置面板：4策略切换+参数调节，双向绑定extractionConfig | `.../editor/components/inspectors/configs/` |
| `FrameExtractSubStep.tsx` | 25 | 关键帧子步骤独立组件（statusKey 硬编码 '张'） | `.../editor/components/steps/sub-steps/` |
| `AudioSeparationSubStep.tsx` | 33 | 音频分离子步骤独立组件 | 同上 |
| `ASRSubStep.tsx` | 38 | ASR台词识别子步骤独立组件 | 同上 |
| `FaceDetectionSubStep.tsx` | 32 | 人物识别子步骤独立组件 | 同上 |

### 2.2 节点解析器（3个文件，共 72 行）

| 文件 | 行数 | 职责 | 位置 |
|------|------|------|------|
| `ASRParser.ts` | 27 | 将 ASR PipelineNodeRef 解析为 PipelineTask | `.../core/parsers/` |
| `AudioSeparateParser.ts` | 27 | 将 audio-separate PipelineNodeRef 解析为 PipelineTask | 同上 |
| `FaceDetectParser.ts` | 18 | 将 face-detect PipelineNodeRef 解析为 PipelineTask | 同上 |

### 2.3 后端策略（4个文件，共 420 行）

| 文件 | 行数 | 职责 | 位置 |
|------|------|------|------|
| `AudioSeparateStrategy.ts` | 68 | nodeType='audio-separate'，调用AudioProcessor分离人声+BGM | `.../main/engine/strategies/` |
| `ASRStrategy.ts` | 61 | nodeType='asr'，委托LocalWhisperStrategy执行识别 | 同上 |
| `LocalWhisperStrategy.ts` | 259 | ASR核心：SenseVoice优先→whisper-cli降级，解析SRT/JSON | 同上 |
| `FaceDetectStrategy.ts` | 32 | nodeType='face-detect'，通过AIDaemon调用/api/vision | 同上 |

### 2.4 管线引擎（3个文件，共 1131 行）

| 文件 | 行数 | 职责 | 位置 |
|------|------|------|------|
| `ExtractionPipeline.ts` | 308 | 旧版单体管线：抽帧+音频+ASR+人脸+语义一体化执行 | `.../main/engine/` |
| `PipelineEngine.ts` | 455 | 新版DAG引擎：按nodeType路由到注册策略，支持拓扑排序 | 同上 |
| `SimplePipelineRunner.ts` | 368 | 固定7步骤管线：extract_frames→...→tts_export | 同上 |

### 2.5 Store 与状态（2个文件，共 375 行）

| 文件 | 行数 | 职责 | 位置 |
|------|------|------|------|
| `useStore.ts` | 25 | 全局Zustand Store聚合：UI+Player+Data+Editor | `.../renderer/src/store/` |
| `usePipelineStore.ts` | 105 | 独立管线Store（subStepStatuses/subStepProgresses等重复定义） | 同上 |
| `storeTypes.ts` | 270 | EditorSlice完整类型定义（含全部步骤1-5状态） | 同上 |

### 2.6 Hooks 与编排（2个文件，共 507 行）

| 文件 | 行数 | 职责 | 位置 |
|------|------|------|------|
| `usePipelineOrchestrator.ts` | 345 | 统一管线编排器：步骤1调用API.media.process，步骤2-5调用API.engine | `.../editor/hooks/` |
| `usePipelineResultMapper.ts` | 162 | 管线执行结果→Store状态映射（按nodeType分发） | 同上 |

### 2.7 常量、类型与工具（5个文件，共 470 行）

| 文件 | 行数 | 职责 | 位置 |
|------|------|------|------|
| `pipelineConstants.ts` | 80 | 步骤定义、CODE_TO_NAME映射、PipelineNodeType枚举 | `.../editor/utils/` |
| `entities/editor.ts` | 59 | AsrLine/VlmFrame/ScriptParagraph等实体类型定义 | `.../shared/types/` |
| `shared/types/index.ts` | 156 | Role/Shot/PipelineTask等共享类型 | `.../shared/types/` |
| `IpcConstants.ts` | 220 | IPC通道常量 | `.../infra/ipc/` |
| `FrameExtractor.ts` | 160 | 4策略FFmpeg抽帧能力类 | `.../main/engine/media/` |

---

## 3. 依赖分析

### 3.1 内部依赖图

```
StepPanel.tsx
  └── StepMaterialAnalysis.tsx          ← 容器（直接读全局Store）
        └── StepMaterialAnalysisView.tsx ← 视图（Props驱动）
              ├── FrameExtractConfig.tsx
              ├── FrameExtractSubStep.tsx  ← 也直接读全局Store
              ├── AudioSeparationSubStep.tsx
              ├── ASRSubStep.tsx
              └── FaceDetectionSubStep.tsx

usePipelineOrchestrator.ts  ← 调用 API.media.process / API.engine.runPipeline
  ├── pipelineConstants.ts (STEP_SEQUENCES)
  └── usePipelineResultMapper.ts
        └── pipelineConstants.ts (classifyNodeId, PipelineNodeType)

PipelineEngine.ts  ← 注册所有策略
  ├── AudioSeparateStrategy.ts → AudioProcessor.ts
  ├── ASRStrategy.ts → LocalWhisperStrategy.ts → AIDaemon / whisper-cli
  ├── FaceDetectStrategy.ts → AIDaemon
  └── VisionExtractStrategy.ts / ScriptGenStrategy.ts / ...

SimplePipelineRunner.ts  ← 固定顺序执行
  ├── VisionExtractStrategy / AudioSeparateStrategy / LocalWhisperStrategy
  ├── FaceDetectStrategy / ScriptGenStrategy / TTSStrategy
  └── PipelineStepRegistry.ts

ExtractionPipeline.ts  ← 旧版（被 JobScheduler 使用）
  ├── VideoProcessor.ts (extractFrames)
  ├── AudioProcessor.ts (extractAudioForASR / separateVocals)
  ├── VisionProcessor.ts (scanFaces / clusterFaces)
  └── MediaEngine.ts (assemblePipelineData)
```

### 3.2 外部依赖（被谁引用）

| 被引用文件 | 引用者 |
|-----------|--------|
| `StepMaterialAnalysis.tsx` | `StepPanel.tsx` (case 1) |
| `ExtractionPipeline.ts` | `JobScheduler.ts` |
| `AudioSeparateStrategy.ts` | `PipelineEngine.ts`, `SimplePipelineRunner.ts` |
| `ASRStrategy.ts` | `PipelineEngine.ts` |
| `LocalWhisperStrategy.ts` | `SimplePipelineRunner.ts`, `ASRStrategy.ts` |
| `FaceDetectStrategy.ts` | `PipelineEngine.ts`, `SimplePipelineRunner.ts` |
| `ASRParser.ts` / `AudioSeparateParser.ts` / `FaceDetectParser.ts` | `ActionParser.ts` (ParserRegistry) |

### 3.3 关键依赖路径

```
用户点击"启动" (步骤1)
  → usePipelineOrchestrator.startCurrentStep()
    → API.media.process(projectId, activeMedia, config)
      → IPC: media:process
        → JobScheduler.ts → ExtractionPipeline.execute()
          → 双子星并行：抽帧 + 音频分离
          → ASR (LocalWhisperStrategy)
          → 人脸 (VisionProcessor)
        → 通过 IPC progress 事件回传状态
```

---

## 4. 与架构规格的差距

### 4.1 结构差距

| 差距 | 严重程度 | 说明 |
|------|---------|------|
| **无独立模块目录** | 🔴 高 | 代码分散在 7 个不同目录，未按 `step1-material/` 组织 |
| **无 types.ts 接口契约** | 🔴 高 | 架构文档定义的 Step1Input/Step1Output/Step1State 未实现为独立的 types.ts |
| **无 index.ts 模块入口** | 🔴 高 | 无法做到"只导出 types.ts 中定义的接口" |
| **无 MODULE.md 功能规格** | 🟡 中 | 缺少模块级别文档 |
| **无 Repository 层** | 🟡 中 | step1 数据通过 API.project.saveData 统一持久化，无专用 Repository |
| **无 __tests__ 目录** | 🟡 中 | 所有文件均无单元测试 |

### 4.2 Store 与状态差距

| 差距 | 严重程度 | 说明 |
|------|---------|------|
| **Store 重复定义** | 🔴 高 | `usePipelineStore.ts` 和 `storeTypes.ts` 中两处定义 subStepStatuses/subStepProgresses/pipelineParams/extractionConfig |
| **step1 状态嵌入全局 Store** | 🔴 高 | EditorSlice 包含全部 5 个步骤状态，step1 的 asrLines/roles/audioSeparated 等直接定义在 EditorSlice 中 |
| **子步骤 statusKey 不一致** | 🟡 中 | FrameExtractSubStep 使用 `subStepStatuses['张']`，主视图使用 `subStepStatuses['frames']` |

### 4.3 接口契约差距

| 差距 | 严重程度 | 说明 |
|------|---------|------|
| **缺少 Step1Input 正式定义** | 🔴 高 | 当前由 `usePipelineOrchestrator` 中手动拼接 config 对象，类型为 any |
| **缺少 Step1Output 正式定义** | 🔴 高 | ExtractionPipeline 返回的 result 对象无类型约束 |
| **AsrLine 接口字段不完整** | 🟡 中 | 架构文档定义 `end?` 字段，当前 `entities/editor.ts` 中 AsrLine 已有 end 字段但缺少 `originalText?` |

### 4.4 组件拆分差距

| 差距 | 严重程度 | 说明 |
|------|---------|------|
| **Container/View 未独立为文件** | 🟡 中 | StepMaterialAnalysis.tsx 和 StepMaterialAnalysisView.tsx 已拆分但仍在旧目录 |
| **子步骤组件直接访问全局 Store** | 🟡 中 | FrameExtractSubStep 等4个子步骤组件 import useStore 而非通过 Props 接收 |
| **FrameExtractConfig 内联在 configs/ 下** | 🟡 中 | 属于 step1 的专属配置面板，应在 step1-material/frontend/components/ 下 |
| **硬编码 UI 文案** | 🟡 中 | '张'、'等待'、'Frame Extract' 等未使用 i18n key |
| **重复的子步骤组件** | 🟡 低 | StepMaterialAnalysisView 内部已包含4个卡片逻辑，sub-steps/ 下又有独立组件实现，存在两套 UI |

### 4.5 后端策略差距

| 差距 | 严重程度 | 说明 |
|------|---------|------|
| **策略分散在两个引擎中** | 🟡 中 | AudioSeparateStrategy 同时被 PipelineEngine 和 SimplePipelineRunner 引用 |
| **ExtractionPipeline 为旧版单体** | 🟡 中 | 308行单体管线，功能与新 PipelineEngine 重叠 |
| **LocalWhisperStrategy 职责过重** | 🟡 中 | 259行包含 ASR+SRT解析+JSON格式化+语言检测，可拆分 |

### 4.6 IPC 与通信差距

| 差距 | 严重程度 | 说明 |
|------|---------|------|
| **无 step1 专用 IPC 通道** | 🟡 中 | 步骤1走 `media:process` 通用通道，架构文档规格建议 `pipeline:runStep` |
| **进度事件无 Zod 校验** | 🟡 低 | TaskProgressPayload 通过 IPC 事件传递，未使用 Zod schema 校验 |

---

## 5. 迁移方案

### 5.1 目标目录结构

```
src/modules/pipeline/step1-material/
├── types.ts                   # Step1Input / Step1Output / Step1State / 子类型
├── index.ts                   # 模块入口（只 export types.ts 内容）
├── MODULE.md                  # 功能规格文档（按架构文档 §3.3.2 编写）
├── frontend/
│   ├── Container.tsx          # 迁移自 StepMaterialAnalysis.tsx（重构为用局部 Store）
│   ├── View.tsx               # 迁移自 StepMaterialAnalysisView.tsx
│   ├── components/
│   │   ├── FrameCard.tsx      # 关键帧卡片（从 View 中抽取）
│   │   ├── AudioCard.tsx      # 音频卡片
│   │   ├── ASRCard.tsx        # ASR 台词卡片
│   │   ├── FaceCard.tsx       # 人脸卡片
│   │   ├── FrameExtractConfig.tsx  # 抽帧配置面板（从 configs/ 迁移）
│   │   └── StatusBadge.tsx    # 子步骤状态指示器
│   └── hooks/
│       └── useStep1Progress.ts # 步骤1进度监听 Hook
├── backend/
│   ├── Service.ts             # Step1Service：编排4个子步骤执行
│   ├── Strategy.ts            # 迁移 AudioSeparateStrategy.ts + 调用策略注册
│   └── FrameExtractor.ts     # 从 main/engine/media/ 迁移（可选，或保持共享）
├── data/
│   ├── Store.ts               # 迁移 usePipelineStore 的 step1 部分（局部 Zustand Store）
│   └── Repository.ts          # 新建：Step1Result DB读写
└── __tests__/
    ├── Container.test.tsx
    ├── Service.test.ts
    └── Store.test.ts
```

### 5.2 分步迁移计划

| 步骤 | 内容 | 预估工作量 | 依赖 |
|------|------|-----------|------|
| **Step 2** | 创建 types.ts + index.ts（接口契约先行） | 0.5天 | 无 |
| **Step 3** | 创建 data/Store.ts（局部 Zustand Store） | 0.5天 | Step 2 |
| **Step 4** | 迁移前端组件（Container/View/components） | 1天 | Step 3 |
| **Step 5** | 迁移后端策略（backend/Strategy.ts） | 0.5天 | Step 2 |
| **Step 6** | 创建 data/Repository.ts | 0.5天 | Step 2 |
| **Step 7** | 创建 backend/Service.ts（编排子步骤） | 0.5天 | Step 5, 6 |
| **Step 8** | 接入管线编排器（替换 usePipelineOrchestrator 步骤1部分） | 0.5天 | Step 7 |
| **Step 9** | 编写单元测试 | 0.5天 | Step 4-7 |
| **Step 10** | 清理旧代码 | 0.5天 | Step 8 |
| **合计** | | **~5天** | |

### 5.3 关键决策点

#### 决策 1：Store 策略

**方案 A（推荐）**：创建 step1-material 专属局部 Store（`data/Store.ts`），从全局 Store 中剥离 step1 专属状态。

- 优势：符合架构文档"每个模块有自己的局部 Store"原则
- 风险：需同步迁移 usePipelineOrchestrator 中引用 step1 状态的部分

**方案 B**：保留全局 Store 中的 step1 状态，仅将 step1-material 的组件改为通过 Props 接收。

- 优势：改动最小
- 风险：不符合架构文档原则

#### 决策 2：后端策略位置

**方案 A（推荐）**：策略类（AudioSeparateStrategy/ASRStrategy/FaceDetectStrategy）保留在 `src/main/engine/strategies/`，step1-material/backend/Service.ts 通过依赖注入引用。

- 优势：策略可被多引擎复用（PipelineEngine + SimplePipelineRunner），不绑定 step1 模块
- 风险：Service.ts 需封装一层调用

**方案 B**：策略类迁移到 step1-material/backend/Strategy.ts 统一管理。

- 优势：模块自包含
- 风险：破坏 PipelineEngine 和 SimplePipelineRunner 的引用，改动范围大

#### 决策 3：ExtractionPipeline 去留

**方案 A（推荐）**：保留 ExtractionPipeline.ts 作为 step1 的 "快速全管线" 模式入口，JobScheduler 继续使用。step1-material/backend/Service.ts 提供细粒度子步骤调用。

**方案 B**：废弃 ExtractionPipeline，统一用 PipelineEngine + DAG。

- 风险：JobScheduler 当前依赖 ExtractionPipeline，改动涉及媒体导入全流程

#### 决策 4：Parser 层去留

ASRParser/AudioSeparateParser/FaceDetectParser 仅被 ActionParser 的 ParserRegistry 使用，与 PipelineEngine 的策略注册形成架构重叠。建议在 Step 8 接入阶段评估是否需要保留。

### 5.4 风险提示

1. **提取 PipelineEngine 引用**：迁移后端 Service 时需小心处理 PipelineEngine 中对 AudioSeparateStrategy/ASRStrategy/FaceDetectStrategy 的直接依赖，避免循环引用。

2. **全局 Store 迁移影响**：usePipelineOrchestrator（345行）大量读取全局 Store 的 step1 状态，拆分局部 Store 后需同步修改编排器。

3. **IPC 进度事件兼容**：当前 ExtractionPipeline 通过 `pipeline:progress` 事件推送子步骤进度，迁移后需保持事件格式兼容。

4. **Sub-steps 组件重复**：sub-steps/ 下的4个独立组件与 StepMaterialAnalysisView 内部卡片逻辑重复，迁移时需要二选一合并。

---

## 6. 迁移完成记录

**迁移日期**: 2026-07-04  
**验证状态**: `tsc --noEmit` (typecheck:node + typecheck:web) 通过，零新增错误（所有已存在错误为预置问题，与本次迁移无关）

### 迁移文件清单

| 新位置 | 来源 | 状态 |
|---|---|---|
| `src/modules/pipeline/step1-material/types.ts` | 架构文档 §3.3.2 定义 | 已创建 |
| `src/modules/pipeline/step1-material/index.ts` | 新建 | 已创建（导出 types） |
| `src/modules/pipeline/step1-material/frontend/Container.tsx` | `StepMaterialAnalysis.tsx` | 已迁移 |
| `src/modules/pipeline/step1-material/frontend/View.tsx` | `StepMaterialAnalysisView.tsx` | 已迁移 |
| `src/modules/pipeline/step1-material/frontend/components/FrameExtractConfig.tsx` | `inspectors/configs/FrameExtractConfig.tsx` | 已迁移 |
| `src/modules/pipeline/step1-material/backend/Strategy.ts` | 新建（管线编排策略骨架） | 已创建 |

### 旧文件处理（@deprecated 重导出）

| 旧路径 | 操作 |
|---|---|
| `renderer/.../steps/StepMaterialAnalysis.tsx` | 改为 re-export → `Container.tsx` |
| `renderer/.../steps/containers/StepMaterialAnalysisView.tsx` | 改为 re-export → `View.tsx` |
| `renderer/.../inspectors/configs/FrameExtractConfig.tsx` | 改为 re-export → `components/FrameExtractConfig.tsx` |

### 消费者导入路径更新

| 文件 | 变更 |
|---|---|
| `StepPanel.tsx` | `./steps/StepMaterialAnalysis` → `../../../../../modules/pipeline/step1-material/frontend/Container` |

### 关键决策执行

| 决策点 | 执行方案 |
|---|---|
| Store 策略 | 保留全局 Store（沿用现有 useStore），Container 层完成读写映射 |
| 策略位置 | AudioSeparateStrategy / ASRStrategy / FaceDetectStrategy 保留原位置（engine/strategies/），新建 Step1MaterialStrategy 骨架 |
| ExtractionPipeline | 保留不迁移，PipelineEngine 引用维持不变 |
| Parser 层 | 暂不处理，留待后续阶段评估 |
| Sub-step 组件 | 选择合并：View.tsx 内联所有子步骤卡片逻辑，sub-steps/ 下4个独立组件未迁移 |
