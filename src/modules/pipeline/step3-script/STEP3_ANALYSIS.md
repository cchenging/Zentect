# Step3-Script 模块分析报告

> **生成日期**: 2026-07-04  
> **分析范围**: 对照架构文档 §3.3.4 完整规格  
> **基准**: `F:\Tools\Zentect\docs\architecture\overview.md` §3.3.4

---

## 1. 源文件清单

共找到 **15 个**相关源文件，按职责分为四层：

### 1.1 前端 UI 层（renderer）

| 文件 | 路径 | 行数 | 修改日期 | 职责 |
|------|------|------|----------|------|
| StepScriptGenerationView.tsx | `renderer/src/pages/editor/components/steps/containers/` | 130 | 2026-07-03 | 纯 Props 视图：风格选择/RSTP滑块/语速按钮/段落编辑卡片/重新生成 |
| StepScriptGeneration.tsx | `renderer/src/pages/editor/components/steps/` | 75 | 2026-06-28 | 控制器：读 Store → 调 API → diff 合并 → 传 View |
| ScriptParagraphEditor.tsx | `renderer/src/pages/editor/components/steps/panels/` | 65 | 2026-06-28 | 独立段落编辑面板（与 View 内联编辑器功能重复） |

### 1.2 共享组件

| 文件 | 路径 | 行数 | 修改日期 | 职责 |
|------|------|------|----------|------|
| ParameterSlider.tsx | `renderer/src/components/shared/` | 25 | 2026-06-27 | R/S/T/P 滑块组件（通用） |

### 1.3 前端工具层（renderer）

| 文件 | 路径 | 行数 | 修改日期 | 职责 |
|------|------|------|----------|------|
| speechPredictor.ts | `renderer/src/pages/editor/utils/` | 107 | 2026-06-27 | 语速-容量预测：检测文案是否超出分镜时长 |
| scriptDiffTree.ts | `renderer/src/pages/editor/utils/` | 111 | 2026-06-27 | LCS 差异对比：新旧文案增量合并，避免全局重绘 |
| pipelineConstants.ts | `renderer/src/pages/editor/utils/` | 80 | 2026-06-27 | SCRIPT_STYLES（6种风格）、STEP_SEQUENCES |
| usePipelineResultMapper.ts | `renderer/src/pages/editor/hooks/` | 162 | 2026-06-27 | 管线结果→Store 映射（含 SCRIPT case） |
| ScriptGenParser.ts | `renderer/src/core/parsers/` | 27 | 2026-06-27 | 管线节点→PipelineTask 转换（旧节点模型） |

### 1.4 后端策略层（main）

| 文件 | 路径 | 行数 | 修改日期 | 职责 |
|------|------|------|----------|------|
| ScriptGenStrategy.ts | `main/engine/strategies/` | 224 | 2026-06-27 | LLM 文案生成：Prompt 组装/RSTP参数注入/敏感词过滤/节奏调整 |

### 1.5 类型 & 状态

| 文件 | 路径 | 行数 | 职责 |
|------|------|------|------|
| editor.ts | `shared/types/entities/` | 59 | ScriptParagraph / PipelineParams / VlmFrame 实体类型 |
| storeTypes.ts | `renderer/src/store/` | 270 | EditorSlice 接口（含 scriptParagraphs/scriptStyle/speechRate/pipelineParams） |
| editorSlice.ts | `renderer/src/store/slices/` | 188 | Zustand 切片实现（setScriptParagraphs/updateScriptParagraph/setPipelineParams 等） |

### 1.6 i18n

| 文件 | 路径 | 行数 | 职责 |
|------|------|------|------|
| editor-steps.ts | `infra/i18n/` | 63 | step3 i18n 键（editor.step3.* 前缀） |

---

## 2. 依赖关系分析

### 2.1 前端依赖图

```
StepScriptGeneration.tsx
  ├── useStore (全局 Zustand Store)
  ├── API.engine.runPipeline (通用管线入口)
  ├── usePipelineResultMapper → classifyNodeId → PipelineNodeType.SCRIPT
  ├── scriptDiffTree (diffParagraphs / applyDiffUpdate)
  ├── pipelineConstants (SCRIPT_STYLES / STEP_SEQUENCES)
  └── StepScriptGenerationView.tsx
        ├── pipelineConstants (SCRIPT_STYLES)
        ├── ParameterSlider (shared component)
        ├── Badge / StatHeader / EmptyState (shared components)
        └── shared/types/entities/editor (ScriptParagraph / PipelineParams / VlmFrame)

ScriptParagraphEditor.tsx
  ├── Badge (shared component)
  └── shared/types/entities/editor (ScriptParagraph)

ScriptGenParser.ts
  ├── shared/types (PipelineTask / PipelineNodeRef / INodeParser)
  └── (旧节点模型，与新的 ScriptGenStrategy 不完全对齐)

speechPredictor.ts
  └── (纯函数，无外部依赖)

scriptDiffTree.ts
  └── (纯函数，无外部依赖)
```

### 2.2 后端依赖图

```
ScriptGenStrategy.ts
  ├── BaseNodeStrategy.ts (抽象基类：validate / performTask)
  ├── LLMFactory.ts (LLM 适配器工厂)
  ├── AppLogger.ts (日志)
  ├── LexiconFilter.ts (三级敏感词扫描 → GeneratedShot.lexiconMarks)
  ├── NetworkPipeline.ts (strictParseJson)
  ├── personas.ts (PERSONAS.SCREENWRITER)
  └── constraints.ts (CONSTRAINTS.NO_MERGE_SENTENCES / JSON_ONLY)
```

### 2.3 全局 Store 依赖（跨模块耦合）

当前 step3 状态挂载在全局 `EditorSlice` 上，与 step1/step2/step4/step5 共享同一个 Zustand Store：

```
EditorSlice (全局)
  ├── scriptParagraphs: ScriptParagraph[]    ← Step3
  ├── scriptStyle: string                     ← Step3
  ├── speechRate: number                      ← Step3
  ├── pipelineParams: {R,S,T,P}              ← Step3
  ├── vlmFrames: VlmFrame[]                  ← Step2（Step3 读取）
  ├── pipelineRunning: boolean               ← 共享
  ├── stepStatuses: StepStatus[]             ← 共享
  └── ... (step1/4/5 状态)
```

`StepScriptGeneration.tsx` 读取 `vlmFrames`（来自 step2）作为匹配画面依据，这是 step3→step2 的数据依赖。

---

## 3. 与架构规格的差距分析

对照架构文档 §3.3.4 step3-script 完整规格，逐项列出差距：

### 3.1 模块结构（严重偏离）

| 规格要求 | 现状 | 差距 |
|----------|------|------|
| `src/modules/pipeline/step3-script/` 目录 | 文件散落在 6 个不同目录 | **无模块目录** |
| `types.ts`（输入输出接口） | 类型分散在 `shared/types/entities/editor.ts` 和 `storeTypes.ts` | 无独立接口文件 |
| `index.ts`（只导出 types.ts） | 无 | 无模块入口 |
| `frontend/Container.tsx` | `StepScriptGeneration.tsx` (非标准路径) | 路径不对 |
| `frontend/View.tsx` | `StepScriptGenerationView.tsx` (非标准路径) | 路径不对 |
| `backend/Service.ts` | 无 | **缺失** |
| `backend/Strategy.ts` | `ScriptGenStrategy.ts` (非标准路径) | 路径不对 |
| `data/Store.ts` | 全局 `editorSlice.ts` | 无局部 Store |
| `data/Repository.ts` | 无 | **缺失** |
| `__tests__/` | 无 | **缺失** |

### 3.2 Store 架构（严重偏离）

| 规格要求 | 现状 | 差距 |
|----------|------|------|
| 每个模块有自己的局部 Store | 全局 Zustand Store (`EditorSlice`) | 架构要求模块隔离，当前所有步骤共享全局 Store |
| 不共享全局 Store | 6 个步骤共享 `EditorSlice` | 违反 §1.3 通信规则第 4 条 |
| Store 状态类型为 `Step3State` | `EditorSlice` 包含所有步骤状态 | 无法独立测试/部署 |

### 3.3 接口契约

| 规格要求 | 现状 | 差距 |
|----------|------|------|
| `Step3Input` 接口（含 vlmFrames/scriptStyle/speechRate/pipelineParams） | 无显式接口定义，通过 Props 隐式传递 | 无类型化输入契约 |
| `Step3Output` 接口（含 scriptParagraphs） | `ScriptParagraph[]` 类型存在但不叫 `Step3Output` | 未按规格命名 |
| `PipelineParams` 接口 | 存在且与规格一致 ✓ | — |

### 3.4 组件拆分

| 规格要求 | 现状 | 差距 |
|----------|------|------|
| Container/View 分离 | `StepScriptGeneration.tsx` + `StepScriptGenerationView.tsx` | 已遵循 ✓ |
| 独立段落编辑组件 | `ScriptParagraphEditor.tsx` 存在但与 View 内联编辑器功能重复 | **冗余**：View 内部和 Editor 都实现了段落卡片编辑 |
| 段落卡片含 shotId/时长/情绪/文本/匹配按钮 | View 内联实现了大部分，shotId 有但未标准化 | 基本满足 |
| "匹配画面" 功能 | `handleMatchVision` 是空实现（stub） | **缺失核心功能** |

### 3.5 后端策略

| 规格要求 | 现状 | 差距 |
|----------|------|------|
| LLM 调用生成段落级文案 | `ScriptGenStrategy.performTask` 完整实现 | 已实现 ✓ |
| R/S/T/P 参数注入 Prompt | 已注入 system prompt | 已实现 ✓ |
| 风格选择（6种） | `STYLE_PROMPTS` 含 6 种风格 | 已实现 ✓ |
| 敏感词过滤 | `LexiconFilter.scan()` 三级扫描 | 已实现 ✓ |
| 语速约束 | `speechRate` 参数参与 Prompt | 已实现 ✓ |
| 情绪标签生成 | LLM 不输出 emotion 字段（未在 Prompt 中要求） | **缺失**：emotion 字段来自前端下拉而非 AI 输出 |
| 错误处理（AppError） | 使用 `throw new Error()` | 未使用 `AppError` + 用户可见消息 |

### 3.6 控件清单对照

| 规格控件 | 现状 | 差距 |
|----------|------|------|
| 风格下拉 | ✓ 已实现（select + SCRIPT_STYLES） | — |
| R/S/T/P 滑块 | ✓ 已实现（ParameterSlider x4） | — |
| 语速按钮（5档） | ✓ 已实现（SPEECH_RATE_OPTIONS x5） | — |
| 情绪下拉 | ✓ 已实现（EMOTIONS 8种） | — |
| 文本编辑区 | ✓ 已实现（textarea） | — |
| 匹配画面按钮 | 按钮存在但 `handleMatchVision` 为空 stub | **功能缺失** |
| 重新生成按钮 | ✓ 已实现 | — |
| 空状态 | ✓ 已实现（EmptyState） | — |
| **溢出警告** | `speechPredictor.ts` 存在但**未接入视图** | **未集成** |
| **当前字数/预估时长** | View 中部分实现（totalChars/estimatedDuration） | 规格有 `totalChars` / `estimatedDuration` i18n key，但 View 用的是硬编码中文 |

### 3.7 i18n 对齐

| 规格 key | 现状 key | 差距 |
|----------|----------|------|
| `pipeline.step3.title` | `editor.step3.title` | 前缀不匹配（规格要求 `pipeline.step3.*`） |
| `pipeline.step3.styleLabel` | `editor.step3.styleLabel` | 同上 |
| `pipeline.step3.paramR` | `editor.step3.paramR` | 同上 |
| `pipeline.step3.paramS` | `editor.step3.paramS` | 同上 |
| `pipeline.step3.paramT` | `editor.step3.paramT` | 同上 |
| `pipeline.step3.paramP` | `editor.step3.paramP` | 同上 |
| `pipeline.step3.rateLabel` | `editor.step3.rateLabel` | 同上 |
| `pipeline.step3.regenerate` | `editor.step3.regenerate` | 同上 |
| `pipeline.step3.generating` | **缺失** | 无对应 key，View 中硬编码 `"生成中..."` |
| `pipeline.step3.matchVision` | `editor.step3.matchVision` | 前缀不匹配 |
| `pipeline.step3.matching` | **缺失** | 无对应 key，View 中硬编码 `"匹配中..."` |
| `pipeline.step3.empty` | **缺失** | View 中硬编码 `"解说文案待生成"` |
| `pipeline.step3.emptyDesc` | **缺失** | View 中硬编码描述文本 |
| `pipeline.step3.overflowWarning` | `editor.step3.overflowWarning` | 前缀不匹配，且功能未接入视图 |
| `pipeline.step3.totalChars` | **缺失** | View 中硬编码 `"当前字数"` |
| `pipeline.step3.estimatedDuration` | **缺失** | View 中硬编码 `"预估时长"` |

### 3.8 IPC 通信

| 规格要求 | 现状 | 差距 |
|----------|------|------|
| `pipeline:runStep` 通道 | `API.engine.runPipeline` (通用) | 无专用 IPC 通道定义 |
| Zod 校验 | 无 | 无请求/响应 Schema 校验 |

### 3.9 日志 & 错误处理

| 规格要求 | 现状 | 差距 |
|----------|------|------|
| `logger.info('step3-script', ...)` | `AppLogger.info('ScriptGenStrategy', ...)` | module 标识不一致（规格要求 `step3-script`） |
| `AppError` 抛错 | `throw new Error(...)` | 无 `AppError` code + userMessage |
| 日志分级 | 仅 INFO/ERROR | 缺少 DEBUG/WARN 级别 |

### 3.10 数据层

| 规格要求 | 现状 | 差距 |
|----------|------|------|
| Repository 持久化 | 无 | 文案数据仅存在 Store 内存中，无 DB 持久化 |
| SQLite 表 | 无 step3 专属表 | `step_results` 表存在但未被 step3 使用 |

---

## 4. 迁移方案（概要）

### 4.1 目标目录结构

```
src/modules/pipeline/step3-script/
├── types.ts              # Step3Input / Step3Output / ScriptParagraph / PipelineParams
├── index.ts              # 只导出 types.ts
├── MODULE.md             # 功能规格文档
├── frontend/
│   ├── Container.tsx     # 从 StepScriptGeneration.tsx 迁移
│   ├── View.tsx          # 从 StepScriptGenerationView.tsx 迁移
│   └── components/
│       ├── ParagraphCard.tsx    # 从 View 内联段落卡片抽取
│       ├── StyleSelector.tsx    # 风格下拉
│       └── SpeechRateSelector.tsx # 语速按钮组
├── backend/
│   ├── Service.ts        # 新建：封装 ScriptGenStrategy 调用 + AppError
│   └── Strategy.ts       # 从 ScriptGenStrategy.ts 迁移
├── data/
│   ├── Store.ts          # 新建：局部 Zustand Store（Step3State）
│   └── Repository.ts     # 新建：step_results 表读写
├── utils/
│   ├── speechPredictor.ts # 从 editor/utils/ 迁移
│   └── scriptDiffTree.ts  # 从 editor/utils/ 迁移
└── __tests__/
    ├── Service.test.ts
    ├── View.test.tsx
    └── Store.test.ts
```

### 4.2 关键迁移步骤

1. **创建目录骨架**：建立上述目录结构，初始化 `types.ts` 和 `index.ts`
2. **提取局部 Store**：从全局 `EditorSlice` 中剥离 step3 相关状态到 `data/Store.ts`
3. **迁移前端组件**：`StepScriptGeneration.tsx` → `Container.tsx`，`StepScriptGenerationView.tsx` → `View.tsx`，消除 `ScriptParagraphEditor.tsx` 冗余
4. **迁移后端策略**：`ScriptGenStrategy.ts` → `backend/Strategy.ts`，新增 `Service.ts` 包装层
5. **新建 Repository**：实现文案持久化到 `step_results` 表
6. **修复 i18n**：key 前缀从 `editor.step3.*` 改为 `pipeline.step3.*`，补充缺失 key
7. **接入溢出警告**：将 `speechPredictor.ts` 结果接入 View 的溢出警告 UI
8. **实现匹配画面**：从 stub 改为真实调用（依赖 step5 的 matcher）
9. **补测试**：Service / View / Store 单元测试
10. **更新全局 Store**：删除 `EditorSlice` 中的 step3 字段，改为引用 step3 模块

### 4.3 风险点

- **全局 Store 解耦**：其他步骤（step2/step4/step5）和 `usePipelineResultMapper.ts` 引用了 `EditorSlice` 的 step3 字段，需要同步更新引用方
- **`ScriptGenParser.ts`**：属于旧节点模型解析器，与新 `ScriptGenStrategy.ts` 不完全对齐，迁移后需评估是否废弃
- **匹配画面功能**：依赖 `bidirectionalMatcher`（尚未实现），迁移时可保留 stub，不必在本阶段完成

---

> **结论**: step3-script 的核心业务逻辑（风格选择、RSTP 参数、LLM 生成、敏感词过滤、语速约束）已在前端和后端分别实现了 80% 以上。主要差距在**模块结构**（散落多目录）、**Store 架构**（全局而非局部）、**缺失功能**（匹配画面 stub、溢出警告未接入、emotion 非 AI 生成）、**工程规范**（i18n 前缀、AppError、日志、Repository、测试）。迁移风险可控，核心逻辑可复用。

---

## 7. 迁移记录

### 2026-07-04 — Phase 4 迁移完成

按 step4-tts 样板完成 step3-script 模块化迁移。

**创建的新文件（4 个）**：

| 文件 | 状态 | 说明 |
|------|------|------|
| `types.ts` | ✅ 新建 | 按 §3.3.4 定义 Step3Input/Output/PipelineParams/StepScriptGenerationProps，路径对齐 `../../../shared/` |
| `index.ts` | ✅ 新建 | 仅导出 types（Step3Input/Output/ScriptParagraph/PipelineParams/StepScriptGenerationProps） |
| `frontend/Container.tsx` | ✅ 新建 | 从旧 StepScriptGeneration.tsx 提取，路径调整为 `../../../../renderer/src/...` |
| `frontend/View.tsx` | ✅ 新建 | 从旧 StepScriptGenerationView.tsx 提取，Props 类型从 `../types` 导入 |

**旧文件 @deprecated 重导出（2 个）**：

| 文件 | 状态 |
|------|------|
| `renderer/.../steps/StepScriptGeneration.tsx` | ✅ 替换为重导出 |
| `renderer/.../steps/containers/StepScriptGenerationView.tsx` | ✅ 替换为重导出 |

**消费者修复**：

| 文件 | 变更 |
|------|------|
| `StepPanel.tsx` | 导入路径 `'./steps/StepScriptGeneration'` → `'../../../../../modules/pipeline/step3-script/frontend/Container'` |

**验证结果**：`tsc --noEmit` 零错误通过
