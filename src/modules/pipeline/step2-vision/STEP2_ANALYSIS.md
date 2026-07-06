# Step2-Vision 模块分析报告

> **生成日期**：2026-07-04  
> **分析方法**：通读架构规格 → 搜索全项目源文件 → 逐文件分析职责/行数/依赖/差距  
> **原则**：只分析不迁移，不修改任何文件

---

## 一、架构规格对照（来源：docs/architecture/overview.md §3.3.3）

### 1.1 输入接口

```typescript
export interface Step2Input extends Partial<Step1Output> {
  framePaths: string[];  // 来自步骤1
  asrText: string;       // 来自步骤1的ASR文本（上下文）
}
```

### 1.2 输出接口

```typescript
export interface Step2Output {
  vlmFrames: VlmFrame[];
  storyLine: string;
}

export interface VlmFrame {
  url: string;
  description: string;
  editing: boolean;
  confirmed: boolean;
}
```

### 1.3 UI/UX 规格要点

| 项 | 规格 |
|---|---|
| 布局 | 帧列表垂直排列，每帧一行：左缩略图(100x68px) + 右描述文本 |
| 编辑 | 描述文本可点击编辑 |
| 故事脉络 | 底部卡片，所有帧描述拼接 |
| 放大 | 图片点击放大查看，左右箭头翻页，ESC关闭 |
| 空状态 | 引导用户先完成步骤1 |
| 控件 | 帧缩略图(→放大)、描述文本(→编辑)、放大-上一帧/下一帧/关闭 |

### 1.4 文案规格（i18n key）

| key | 中文 |
|---|---|
| `pipeline.step2.title` | VLM 画面描述 |
| `pipeline.step2.framesAnalyzed` | {count} 帧已分析 |
| `pipeline.step2.confirmed` | 已确认 {count} 帧 |
| `pipeline.step2.storyLine` | 故事脉络 |
| `pipeline.step2.empty` | 执行素材分析后，画面描述将在此展示 |
| `pipeline.step2.goStep1` | 前往素材分析 |
| `pipeline.step2.clickToEdit` | 点击添加描述 |

---

## 二、源文件清单

### 2.1 核心文件（14个）

| # | 文件路径 | 行数 | 职责 |
|---|---|---|---|
| 1 | `src/renderer/src/pages/editor/components/steps/containers/StepVisionDescriptionView.tsx` | 105 | 前端主视图：帧列表、缩略图、描述编辑、放大弹窗、故事脉络 |
| 2 | `src/main/engine/strategies/VisionExtractStrategy.ts` | 364 | 后端策略：逐帧VLM分析、5路并发、滑动窗口、流式推送 |
| 3 | `src/main/controllers/AIController.ts`（visionExtract段） | ~130 | 旧版IPC处理：分批VLM调用、base64编码、描述行拆分 |
| 4 | `src/shared/types/entities/editor.ts` | 59 | 实体类型定义：VlmFrame 接口 |
| 5 | `src/shared/types/contracts/step-data.ts` | 58 | 步骤间数据契约：VisionOutput / VisionInput / ScriptGenInput |
| 6 | `src/renderer/src/store/storeTypes.ts`（L184-L249） | ~65 | Store类型：vlmFrames + VLM操作方法签名 |
| 7 | `src/renderer/src/store/slices/editorSlice.ts`（L47-150） | ~103 | Store实现：setVlmFrames / updateVlmDescription / setVlmEditing |
| 8 | `src/renderer/src/store/slices/dataSlice.ts`（L395-L495） | ~100 | 数据持久化恢复：从metadata恢复vlmFrames |
| 9 | `src/renderer/src/pages/editor/hooks/usePipelineOrchestrator.ts`（L70-L170） | ~100 | 管线编排：步骤2独立执行路径，映射结果到store |
| 10 | `src/renderer/src/pages/editor/hooks/useExtractionHandler.ts`（L85-L255） | ~170 | 步骤1完成回调：从shots构建vlmFrames，持久化 |
| 11 | `src/renderer/src/pages/editor/hooks/PipelineResultAdapter.ts` | 125 | 管线结果分类映射：vlm_analyze → store |
| 12 | `src/infra/i18n/editor-steps.ts` | 63 | i18n词典：editor.step2.* 三个key |
| 13 | `src/renderer/src/pages/editor/utils/pipelineConstants.ts` | 80 | 步骤常量：步骤2定义、STEP_SEQUENCES映射 |
| 14 | `src/main/engine/prompts/PromptBuilder.ts`（L95-L124） | 30 | Vision Extract的systemPrompt/userPrompt构建 |

### 2.2 关联文件（6个）

| # | 文件路径 | 关联性质 |
|---|---|---|
| 15 | `src/renderer/src/api/index.ts`（L83） | visionExtract API调用封装 |
| 16 | `src/preload/index.ts`（L84） | visionSingle IPC暴露 |
| 17 | `src/main/database/queries/ProjectQueries.ts`（L55-83） | shots表 INSERT / UPDATE_SHOT_VISION |
| 18 | `src/main/database/repositories/ProjectRepository.ts`（L225-L265） | metadata持久化vlmFrames |
| 19 | `src/main/engine/strategies/BaseNodeStrategy.ts` | VisionExtractStrategy基类 |
| 20 | `src/shared/types/entities/__tests__/editor-entities.test.ts` | VlmFrame 单元测试 |

---

## 三、依赖关系分析

### 3.1 前端依赖图

```
StepVisionDescriptionView.tsx (纯Props组件)
  ├── imports: VlmFrame (from shared/types/entities/editor)
  ├── imports: getSafeMediaUrl, StatHeader, EmptyState (shared components)
  └── called by: Editor右侧步骤面板 (props传入)

usePipelineOrchestrator.ts (步骤2独立路径)
  ├── reads: state.extractedData.framePaths, state.mediaItems
  ├── calls: API.ai.visionExtract(projectId, mediaPath, mediaId, existingFrames)
  ├── writes: state.setVlmFrames(manual mapping)
  └── NOTE: 步骤2不走PipelineEngine，与步骤3-5路径不同

useExtractionHandler.ts (步骤1完成后初始化)
  ├── reads: shots[].visionText / shots[].contextFrames
  ├── writes: state.setVlmFrames(vlmFramesData)
  └── NOTE: 另一条vlmFrames初始化路径（从DB shots恢复）

PipelineResultAdapter.ts (管线结果映射)
  ├── classifyNodeResult: 'vlm_analyze' → VlmFrame[]
  └── applyPipelineResult: 统一写入store

Store层
  ├── editorSlice: vlmFrames / setVlmFrames / updateVlmDescription / setVlmEditing
  └── dataSlice: hydrateProjectData 从metadata恢复vlmFrames
```

### 3.2 后端依赖图

```
VisionExtractStrategy.ts (新管线路径)
  ├── extends: BaseNodeStrategy<VisionExtractInput, VisionExtractOutput>
  ├── imports: VisionProcessor, LLMFactory, PromptBuilder
  ├── uses: context.bus.get('asr-result') — 从步骤1读取ASR
  ├── outputs: FrameDetail[] → context.bus.set(nodeId, results)
  └── lifecycle: PipelineEngine → execute() → performTask()

AIController.ts (旧IPC路径)
  ├── handles: IPC_CHANNELS.AI_VISION_EXTRACT ('vision:extract')
  ├── logic: 手动分批VLM调用 + base64编码 + 描述字符串拆分
  ├── imports: LLMFactory (直接调用，不经过VisionExtractStrategy)
  └── NOTE: 与VisionExtractStrategy功能重叠，但实现路径不同

数据库层
  ├── shots表: vision_text TEXT, context_frames TEXT (旧版逐shot存储)
  ├── projects表: metadata JSON → vlmFrames字段 (新版统一持久化)
  └── ProjectRepository.saveData: 写入metadata.vlmFrames
```

### 3.3 数据流

```
[步骤1完成] → framePaths + ASR lines
       │
       ├──→ useExtractionHandler: shots.visionText/contextFrames → setVlmFrames (恢复路径)
       │
       └──→ usePipelineOrchestrator (step=2):
              API.ai.visionExtract(projectId, mediaPath, mediaId, framePaths)
                │
                ├──→ AIController.visionExtract:
                │      LLMFactory('visual').chat() batch模式
                │      → {framesCount, sceneDescriptions, framePaths}
                │
                └──→ 手动 map → VlmFrame[] → state.setVlmFrames()

[PipelineEngine路径] (步骤2在PipelineEngine中执行时):
    VisionExtractStrategy.performTask()
      → 逐帧并发VLM (CONCURRENT_VLM=5)
      → 流式推送 partialFrames
      → context.bus.set(nodeId, results)
      → PipelineResultAdapter.classifyNodeResult('vlm_analyze')
      → store.setVlmFrames(frames)
```

---

## 四、差距分析：规格 vs 现状

### 4.1 结构差距（模块组织）

| 规格要求 | 现状 | 差距等级 |
|---|---|---|
| `src/modules/pipeline/step2-vision/types.ts` | ❌ 不存在 | 🔴 严重 |
| `src/modules/pipeline/step2-vision/index.ts` | ❌ 不存在 | 🔴 严重 |
| `src/modules/pipeline/step2-vision/MODULE.md` | ❌ 不存在 | 🔴 严重 |
| `src/modules/pipeline/step2-vision/frontend/` | ❌ 不存在 | 🔴 严重 |
| `src/modules/pipeline/step2-vision/backend/` | ❌ 不存在 | 🔴 严重 |
| `src/modules/pipeline/step2-vision/data/` | ❌ 不存在 | 🔴 严重 |
| `src/modules/pipeline/step2-vision/__tests__/` | ❌ 不存在 | 🔴 严重 |

> 当前所有 step2 代码分散在 renderer/pages/editor/*、main/engine/strategies/*、shared/types/* 等位置，未按架构规格收拢到 `modules/pipeline/step2-vision/` 目录。

### 4.2 类型/接口差距

| 项 | 规格 | 现状 | 差距 |
|---|---|---|---|
| Step2Input | `{ framePaths: string[], asrText: string }` | `VisionExtractInput` 含 mediaId/mediaPath/modelName/framesMode 等额外字段 | 🟡 扩展了额外参数，但核心字段匹配 |
| Step2Output | `{ vlmFrames: VlmFrame[], storyLine: string }` | `VisionOutput` contract 已定义 vlmFrames+storyLine | 🟢 匹配 |
| VlmFrame | `{ url, description, editing, confirmed }` | `editor.ts` 中定义完全一致 | 🟢 匹配 |
| FrameDetail | 规格无此类型 | `VisionExtractStrategy` 内部有 FrameDetail（含 asrText/asrTime/timeMs/emotion 等额外字段） | 🟡 内部类型，不影响对外接口 |

### 4.3 Store 差距

| 项 | 规格要求 | 现状 | 差距等级 |
|---|---|---|---|
| `vlmFrames: VlmFrame[]` | ✅ 必须 | ✅ 存在 | 🟢 |
| `setVlmFrames(frames)` | ✅ 必须 | ✅ 存在 | 🟢 |
| `updateVlmDescription(idx, desc)` | ✅ 必须 | ✅ 存在 | 🟢 |
| `setVlmEditing(idx, editing)` | ✅ 必须 | ✅ 存在 | 🟢 |
| `setVlmConfirmed(idx, confirmed)` | ❌ 规格未明确要求，但View需用 | ❌ 不存在 | 🟡 缺少confirmed单独toggle |
| `confirmedCount` 派生状态 | UI需要显示"已确认N帧" | View中计算 `vlmFrames.filter(f=>f.confirmed).length` | 🟢 View内联计算可行 |
| 步骤2独立subStepStatus | 未明确要求 | 无独立状态跟踪 | 🟡 可通过 stepStatuses[1] 跟踪 |

### 4.4 前端组件差距

| 项 | 规格 | StepVisionDescriptionView.tsx 现状 | 差距 |
|---|---|---|---|
| 缩略图尺寸 | 100x68px | `w-[100px] h-[68px]` ✅ | 🟢 |
| 描述文本可编辑 | 点击进入编辑 | `onClick → onSetEditing(idx, true)` ✅ | 🟢 |
| 故事脉络卡片 | 底部显示 | `storyLineText` + 渐变卡片 ✅ | 🟢 |
| 放大弹窗 | 左右箭头翻页，ESC关闭 | `ChevronLeft/Right` + `onKeyDown('Escape')` ✅ | 🟢 |
| 空状态 | 引导到步骤1 | `EmptyState` + `onGoToStep1` 按钮 ✅ | 🟢 |
| 帧编号显示 | 无规格要求 | "帧 {idx+1}" 已有 | 🟢 |
| confirmed 切换按钮 | 未明确要求但合理 | ❌ 无单独的确认/取消确认按钮 | 🟡 View中description编辑后blur自动editing=false，但confirmed无独立控制 |
| StatHeader 统计 | `{count} 帧已分析` | 硬编码 `vlmFrames.length` + "帧已分析" | 🟡 未使用i18n |
| i18n 引用 | 全部 `pipeline.step2.*` | 硬编码中文字符串 | 🔴 未使用i18n |
| 组件拆分 | Container/View分离 | 当前是单文件纯Props组件 | 🟡 缺少Container层，但Props方式已符合架构精神 |

### 4.5 后端差距

| 项 | 规格 | 现状 | 差距等级 |
|---|---|---|---|
| Service层 | `backend/Service.ts` | ❌ 不存在。业务逻辑散布在VisionExtractStrategy和AIController中 | 🔴 严重 |
| Strategy层 | `backend/Strategy.ts` | `VisionExtractStrategy.ts` 存在但位于旧路径 | 🟡 需迁移到模块目录 |
| Repository层 | `data/Repository.ts` | ❌ 不存在。数据通过ProjectRepository的metadata JSON blob存储 | 🟡 缺少独立Repository |
| 两条执行路径 | 应统一 | AIController.visionExtract (旧) vs VisionExtractStrategy.performTask (新) | 🔴 严重 - 功能重复 |
| PipelineEngine集成 | step2应与其他步骤统一走PipelineEngine | 当前usePipelineOrchestrator中步骤2独立调用API不走PipelineEngine | 🔴 严重 - 架构不一致 |
| IPC通道命名 | `pipeline:step2-vision` | `vision:extract` | 🟡 命名不符合规范 |

### 4.6 IPC通信差距

| 项 | 规格 | 现状 | 差距等级 |
|---|---|---|---|
| IPC通道 | 应为 `pipeline:step2-vision` | `vision:extract` (AI_VISION_EXTRACT) | 🟡 |
| preload暴露 | 应有明确接口类型 | `API.ai.visionExtract(...)` 使用any类型 | 🟡 |
| Zod校验 | IPC通道应有requestSchema/responseSchema | 无 | 🟡 |

### 4.7 i18n差距

| 规格 key | 中文 | 现状 key (错误前缀) | 差距等级 |
|---|---|---|---|
| `pipeline.step2.title` | VLM 画面描述 | `editor.step2.title` ✅ 存在但前缀错 | 🔴 |
| `pipeline.step2.framesAnalyzed` | {count} 帧已分析 | ❌ 不存在 | 🔴 |
| `pipeline.step2.confirmed` | 已确认 {count} 帧 | ❌ 不存在 | 🔴 |
| `pipeline.step2.storyLine` | 故事脉络 | `editor.step2.storyLine` ✅ 存在但前缀错 | 🔴 |
| `pipeline.step2.empty` | 执行素材分析后... | `editor.step2.empty` ✅ 存在但前缀错 | 🔴 |
| `pipeline.step2.goStep1` | 前往素材分析 | ❌ 不存在 | 🔴 |
| `pipeline.step2.clickToEdit` | 点击添加描述 | ❌ 不存在 (硬编码"点击添加描述") | 🔴 |

### 4.8 数据库差距

| 项 | 规格 | 现状 | 差距 |
|---|---|---|---|
| vlm_frames独立表 | 未明确要求 | dataSlice从metadata JSON恢复，ProjectRepository写入metadata | 🟡 JSON blob方式兼容性好但查询困难 |
| shots.vision_text | 旧版字段 | 仍在使用（useExtractionHandler从此构建vlmFrames） | 🟡 两条持久化路径共存的兼容性问题 |
| Repository层 | 架构要求每个模块有自己的Repository | 无独立Repository | 🟡 |

---

## 五、非显而易见的架构问题

### 5.1 双路径VLM执行

**问题**：AIController.visionExtract（分批VLM + 简单行拆分）与 VisionExtractStrategy.performTask（逐帧并发VLM + 滑动窗口 + JSON解析）是两套完全不同的实现，功能重叠。

**影响**：
- `usePipelineOrchestrator` 中步骤2调用的是旧版 AIController 路径（简单字符串描述）
- `PipelineEngine` 中执行步骤2时会走 VisionExtractStrategy 路径（结构化JSON描述 + 流式推送）
- 两套路径返回的数据格式不同，前端兼容映射容易出错

### 5.2 步骤2不在 PipelineEngine 内执行

**问题**：`usePipelineOrchestrator.ts` 中步骤2有独立的 `if (step === 2)` 分支，直接调用 `API.ai.visionExtract()`，而步骤3-5走 `PipelineEngine`。

**影响**：
- 步骤2无法利用 PipelineEngine 的进度追踪、错误恢复、检查点机制
- `PipelineResultAdapter.vlm_analyze` 类型和 `STEP_SEQUENCES[2]` 已定义但实际未被使用
- 架构不一致，维护成本高

### 5.3 vlmFrames初始化的两条路径竞争

**问题**：
- `useExtractionHandler`：步骤1完成后从 `shots[].visionText + contextFrames` 构建 vlmFrames
- `usePipelineOrchestrator`：步骤2执行后从API返回构建 vlmFrames

这两条路径可能覆盖彼此的数据。步骤1的旧shots数据可能包含过期的visionText。

### 5.4 BaseNodeStrategy的modelConfig未被VisionExtractStrategy使用

**问题**：`BaseNodeStrategy.execute()` 自动从 `pipeline_model_config` 表读取模型配置注入 `context.modelConfig`，但 `VisionExtractStrategy.performTask()` 内部用 `LLMFactory.createAdapter('visual')` 硬编码 task type，未读取 `context.modelConfig` 中的自定义模型名。

---

## 六、迁移方案建议

### 6.1 目标目录结构

```
src/modules/pipeline/step2-vision/
├── types.ts                          # Step2Input / Step2Output / VlmFrame
├── index.ts                          # 只导出 types.ts
├── MODULE.md                         # 功能规格
├── frontend/
│   ├── Container.tsx                 # 读Store、组装Props
│   ├── View.tsx                      # 纯Props组件（从StepVisionDescriptionView迁移）
│   └── components/
│       └── FrameCard.tsx             # 可提取的单帧卡片组件
├── backend/
│   ├── Service.ts                    # 业务逻辑封装（统一AIController+VisionExtractStrategy）
│   └── Strategy.ts                   # 从VisionExtractStrategy迁移
├── data/
│   ├── Store.ts                      # 步骤2局部Store
│   └── Repository.ts                 # vlmFrames独立持久化
└── __tests__/
    ├── Service.test.ts
    ├── View.test.tsx
    └── Strategy.test.ts
```

### 6.2 迁移步骤（建议顺序）

1. **创建目录 + types.ts + index.ts**：从 `shared/types/entities/editor.ts` 提取 VlmFrame，从 `step-data.ts` 提取 Step2Input/Step2Output
2. **迁移 View**：将 `StepVisionDescriptionView.tsx` 拆分为 `Container.tsx` + `View.tsx`
3. **迁移 Strategy**：将 `VisionExtractStrategy.ts` 移入 `backend/Strategy.ts`，同时解决与 AIController 的双路径问题
4. **统一执行路径**：步骤2纳入 PipelineEngine，删除 `usePipelineOrchestrator` 中的独立分支
5. **创建 Store**：从全局 editorSlice 拆分出步骤2的局部 Store
6. **创建 Repository**：独立持久化 vlmFrames
7. **修复 i18n**：将 `editor.step2.*` 改为 `pipeline.step2.*`，补充缺失key
8. **补全测试**

### 6.3 关键决策点

| 决策 | 建议 | 理由 |
|---|---|---|
| AIController双路径 | 删除旧版visionExtract，统一走VisionExtractStrategy | 减少维护成本，统一数据格式 |
| 步骤2 PipelineEngine集成 | 步骤2纳入PipelineEngine | 统一进度追踪/错误恢复/检查点 |
| vlmFrames持久化 | 保持metadata JSON blob（短期），将来建独立表 | metadata方式已验证可行，独立表可延后 |
| FrameDetail vs VlmFrame | 统一为VlmFrame | FrameDetail是内部类型，不应导出 |
| Store拆分 | 从editorSlice拆出 | 遵循模块独立Store原则 |

---

## 七、文件统计

| 类别 | 文件数 | 总行数（估） |
|---|---|---|
| 前端组件 | 1 | ~105 |
| 后端策略 | 1 | ~364 |
| 后端控制器（旧路径） | 1 | ~130（相关段） |
| Store层 | 3 | ~268 |
| 类型/契约 | 2 | ~117 |
| IPC/API | 2 | ~50（相关段） |
| 管线hooks | 3 | ~395 |
| i18n | 1 | ~63 |
| Prompt | 1 | ~30 |
| 数据库 | 2 | ~85（相关段） |
| **合计** | **17** | **~1607** |

---

> **结论**：前端组件 StepVisionDescriptionView 已经接近架构规格（纯Props、功能完整），主要差距在：① 模块目录结构完全缺失；② 后端存在双路径VLM执行的架构债；③ 步骤2未纳入PipelineEngine统一编排；④ i18n前缀错误且缺key。迁移难度中等，前端迁移成本低，后端统一执行路径是核心挑战。

---

## 7. 迁移完成记录

**日期**：2026-07-04

### 7.1 新建文件

| 文件 | 职责 |
|---|---|
| `types.ts` | Step2Input / Step2Output / StepVisionDescriptionProps |
| `index.ts` | 导出 types.ts 公共接口 |
| `frontend/Container.tsx` | `useStore` → Props 映射，从 StepVisionDescription.tsx 迁入 |
| `frontend/View.tsx` | 纯 Props 组件，从 StepVisionDescriptionView.tsx 迁入 |

### 7.2 旧文件处理

| 旧路径 | 处理方式 |
|---|---|
| `src/renderer/.../steps/StepVisionDescription.tsx` | → `@deprecated` 重导出到 `frontend/Container.tsx` |
| `src/renderer/.../containers/StepVisionDescriptionView.tsx` | → `@deprecated` 重导出到 `frontend/View.tsx` |

### 7.3 消费者导入更新

`StepPanel.tsx`：`import { StepVisionDescription }` 路径从 `./steps/StepVisionDescription` 更新为 `../../../../../modules/pipeline/step2-vision/frontend/Container`

### 7.4 验证

`tsc --noEmit` 通过 (RC=0)，零新增错误。

### 7.5 未迁移项（后续任务）

- 后端 VLM 执行路径统一（AIController vs VisionExtractStrategy）
- 步骤2纳入 PipelineEngine 编排
- i18n key 前缀修正（editor.step2.* → pipeline.step2.*）及缺失 key 补充
- MODULE.md 编写
