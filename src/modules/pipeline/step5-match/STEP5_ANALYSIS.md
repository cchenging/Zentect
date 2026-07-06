# Step5-Match 模块分析报告

> **生成日期**: 2026-07-04  
> **分析范围**: 对照架构文档 §3.3.6 完整规格  
> **基准**: `F:\Tools\Zentect\docs\architecture\overview.md` §3.3.6

---

## 1. 源文件清单

共找到 **12 个**相关源文件，按职责分四层：

### 1.1 前端 UI 层（renderer）

| 文件 | 路径 | 行数 | 修改日期 | 职责 |
|------|------|------|----------|------|
| StepShotMatching.tsx | `renderer/src/pages/editor/components/steps/` | 60 | 2026-06-28 | 控制器：读 Store → 调 API → 传 View |
| StepShotMatchingView.tsx | `renderer/src/pages/editor/components/steps/containers/` | 113 | 2026-07-03 | 纯 Props 视图：卡片列表/拖拽排序/替换弹窗 |

### 1.2 前端工具层（renderer）

| 文件 | 路径 | 行数 | 修改日期 | 职责 |
|------|------|------|----------|------|
| PipelineResultAdapter.ts | `renderer/src/pages/editor/hooks/` | 125 | — | classifyNodeResult + applyPipelineResult（含 shot_match 分支） |
| usePipelineResultMapper.ts | `renderer/src/pages/editor/hooks/` | 162 | 2026-06-27 | mapPipelineResultToState（含 MATCH case） |
| StepPanel.tsx | `renderer/src/pages/editor/components/` | 160 | — | case 5 路由到 StepShotMatching |

### 1.3 共享组件

| 文件 | 路径 | 行数 | 职责 |
|------|------|------|------|
| DragReorderList.tsx | `renderer/src/components/shared/` | — | 可拖拽排序列表（被 View 使用） |

### 1.4 后端策略层（main）

| 文件 | 路径 | 行数 | 修改日期 | 职责 |
|------|------|------|----------|------|
| SemanticAnalyzeStrategy.ts | `main/engine/strategies/` | 216 | 2026-07-04 | KM 全局匹配算法：BGM节拍检测→场景切片→匈牙利算法匹配→CLIP回退 |

### 1.5 类型 & 状态

| 文件 | 路径 | 行数 | 职责 |
|------|------|------|------|
| editor.ts | `shared/types/entities/` | 59 | MatchResult 实体类型（L34-39） |
| step-data.ts | `shared/types/contracts/` | 58 | MatchingInput / MatchingOutput |
| index.ts | `shared/types/` | 156 | MatchResultItem（更详细的类型） |
| storeTypes.ts | `renderer/src/store/` | 270 | EditorSlice 接口（matchResults/activeBgm/videoChunks/beatTimestamps） |
| editorSlice.ts | `renderer/src/store/slices/` | 188 | Zustand 切片实现（setMatchResults/confirmMatch/replaceMatch 等） |

### 1.6 全局 Store 依赖（跨模块耦合）

```
EditorSlice (全局)
  ├── matchResults: MatchResult[]          ← Step5
  ├── activeBgm: BgmInfo | null            ← Step5
  ├── beatTimestamps: number[]             ← Step5
  ├── videoChunks: any[]                   ← Step5
  ├── mediaItems: MediaItem[]              ← Step1（Step5 读取）
  ├── scriptParagraphs: ScriptParagraph[]  ← Step3（Step5 读取 rematch）
  ├── ttsResults: TtsResult[]              ← Step4（Step5 读取 rematch）
  ├── vlmFrames: VlmFrame[]                ← Step2（Step5 读取 rematch）
  ├── pipelineRunning: boolean             ← 共享
  └── ... (其他步骤状态)
```

---

## 2. 依赖关系分析

### 2.1 前端依赖图

```
StepShotMatching.tsx
  ├── useStore (全局 Zustand Store)
  │   ├── matchResults, mediaItems, activeBgm, videoChunks
  │   ├── pipelineRunning, confirmMatch, setMatchResults
  ├── API.engine.runPipeline (通用管线入口)
  ├── mapPipelineResultToState (→ PipelineNodeType.MATCH)
  ├── STEP_SEQUENCES[5] (pipelineConstants)
  └── StepShotMatchingView.tsx
        ├── DragReorderList (shared component)
        ├── Badge / StatHeader / EmptyState (shared components)
        ├── getSafeMediaUrl (formatUrl)
        └── shared/types/entities/editor (MatchResult / MediaItem / VideoChunk)

StepPanel.tsx
  └── StepShotMatching (case 5 路由)
```

### 2.2 后端依赖图

```
SemanticAnalyzeStrategy.ts
  ├── BaseNodeStrategy.ts (validate / performTask)
  ├── AIDaemon (HTTP 调用 AI 服务)
  ├── AppLogger (日志)
  ├── PathManager (路径工具)
  └── AIDaemon API 端点:
      ├── /api/audio/detect_beats (BGM 节拍检测)
      ├── /api/video/detect_scene_chunks (场景切片)
      ├── /api/solver/kuhn_munkres_match (KM 匹配)
      └── /api/match (CLIP 帧回退匹配)
```

---

## 3. 与架构规格的差距分析

对照架构文档 §3.3.6 step5-match 完整规格，逐项列出差距：

### 3.1 模块结构（严重偏离）

| 规格要求 | 现状 | 差距 |
|----------|------|------|
| `src/modules/pipeline/step5-match/` 目录 | 无 | **无模块目录** |
| `types.ts`（输入输出接口） | 类型分散在 `shared/types/entities/editor.ts`、`shared/types/contracts/step-data.ts`、`shared/types/index.ts` | 无独立接口文件 |
| `index.ts`（只导出 types.ts） | 无 | 无模块入口 |
| `frontend/Container.tsx` | `StepShotMatching.tsx` (非标准路径) | 路径不对 |
| `frontend/View.tsx` | `StepShotMatchingView.tsx` (非标准路径) | 路径不对 |
| `backend/Service.ts` | 无 | **缺失** |
| `backend/Strategy.ts` | `SemanticAnalyzeStrategy.ts` (非标准路径) | 路径不对 |
| `data/Store.ts` | 全局 `editorSlice.ts` | 无局部 Store |
| `data/Repository.ts` | 无 | **缺失** |
| `__tests__/` | 无 | **缺失** |

### 3.2 Store 架构（严重偏离）

| 规格要求 | 现状 | 差距 |
|----------|------|------|
| 模块局部 Store | 全局 Zustand Store (`EditorSlice`) | 所有步骤共享全局 Store，违反 §1.3 第4条 |
| `Step5State` 类型 | `EditorSlice` 含所有步骤状态 | 无法独立测试 |

### 3.3 接口契约

| 规格要求 | 现状 | 差距 |
|----------|------|------|
| `Step5Input` 接口（含 scriptParagraphs/vlmFrames/ttsResults/activeBgm） | `shared/types/contracts/step-data.ts` 中有 `MatchingInput` 且与规格一致 | 已定义但命名不一致 ✓ |
| `Step5Output` 接口（含 matchResults） | `MatchingOutput` 存在且与规格一致 | 已定义但命名不一致 ✓ |
| `MatchResult` 接口 | `shared/types/entities/editor.ts` 中定义，字段与规格完全一致 ✓ | — |

### 3.4 组件拆分

| 规格要求 | 现状 | 差距 |
|----------|------|------|
| Container/View 分离 | `StepShotMatching.tsx` + `StepShotMatchingView.tsx` | 已遵循 ✓ |
| 可拖拽卡片列表（DragReorderList） | DragReorderList 组件已封装并使用 | 已实现 ✓ |
| 缩略图 + 匹配度 Badge + 时长 + 确认/替换 | View 中完整实现 | 已实现 ✓ |
| 边框颜色（≥85%绿/70-84%黄/<70%红） | View 使用 `border-l-accent-green/warning/accent-rose` | 已实现 ✓（阈值略有不同：≥0.85/≥0.6/<0.6） |
| 替换弹窗（2列网格选择片段） | View 中完整实现，带 chunkPool 自动选择 | 已实现 ✓ |

### 3.5 后端策略

| 规格要求 | 现状 | 差距 |
|----------|------|------|
| BGM 节拍检测 | `SemanticAnalyzeStrategy` 调用 `/api/audio/detect_beats` | 已实现 ✓ |
| 场景切片检测 | 调用 `/api/video/detect_scene_chunks` | 已实现 ✓ |
| KM 全局匹配算法 | 调用 `/api/solver/kuhn_munkres_match` | 已实现 ✓ |
| CLIP 帧匹配回退 | `fallbackFrameMatch` 完整实现 | 已实现 ✓ |
| 三维权重（alpha/beta/gamma） | 传入 alpha=0.6/beta=0.3/gamma=0.1 | 已实现 ✓ |
| 错误处理（AppError） | 使用 `throw new Error()` | 未使用 AppError |

### 3.6 控件清单对照

| 规格控件 | 现状 | 差距 |
|----------|------|------|
| 重新匹配按钮 | ✓（含 loading spinner） | — |
| 确认按钮 | ✓（每张卡片底部，confirmed 时显示"已确认"） | — |
| 替换按钮 | ✓（打开替换弹窗） | — |
| 拖拽排序 | ✓（DragReorderList） | — |
| 替换弹窗-片段网格 | ✓（2列，chunkPool 聚合 videoChunks + frame 类型 mediaItems） | — |
| 替换弹窗-关闭 | ✓ | — |
| BGM状态Badge | ✓（hasBgm 时显示绿色 Badge） | — |
| 空状态 | ✓（EmptyState 引导） | 文案与规格略有差异 |

### 3.7 i18n 对齐

| 规格 key | 现状 | 差距 |
|----------|------|------|
| `pipeline.step5.title` | 硬编码 `"镜头匹配"` | **未使用 i18n** |
| `pipeline.step5.confirmed` | 硬编码 `"已确认"` | 未使用 i18n |
| `pipeline.step5.confirm` | 硬编码 `"确认"` | 未使用 i18n |
| `pipeline.step5.replace` | 硬编码 `"替换"` | 未使用 i18n |
| `pipeline.step5.rematch` | 硬编码 `"重新匹配 / 匹配中..."` | 未使用 i18n |
| `pipeline.step5.score` | 硬编码百分比 Badge | 未使用 i18n |
| `pipeline.step5.dragHint` | 硬编码 `"拖拽卡片可调整顺序"` | 未使用 i18n |
| `pipeline.step5.empty` | 硬编码 `"智能匹配待生成"` | 未使用 i18n |
| `pipeline.step5.emptyDesc` | 硬编码描述文本 | 与规格文案不一致 |
| `pipeline.step5.replaceTitle` | 硬编码 `"选择视频片段"` | 未使用 i18n |
| `pipeline.step5.noChunks` | 硬编码 `"暂无片段素材"` | 未使用 i18n |
| `pipeline.step5.bgmActive` | Badge 显示 `"BGM"` | 未使用 i18n |

### 3.8 日志规范

| 规格要求 | 现状 | 差距 |
|----------|------|------|
| `logger.info('step5-match', ...)` | `AppLogger.info(LOG_TAGS.AI_AGENT, '[镜头匹配] ...')` | module 标识不一致（规格要求 `step5-match`） |
| 日志分级 | 仅 INFO/WARN/ERROR | 缺少 DEBUG 级别 |

---

## 4. 迁移方案（概要）

### 4.1 目标目录结构

```
src/modules/pipeline/step5-match/
├── types.ts              # Step5Input / Step5Output / MatchResult / StepShotMatchingProps
├── index.ts              # 只导出 types.ts
├── MODULE.md             # 功能规格文档
├── frontend/
│   ├── Container.tsx     # 从 StepShotMatching.tsx 迁移
│   └── View.tsx          # 从 StepShotMatchingView.tsx 迁移
├── backend/
│   ├── Service.ts        # 新建：封装 SemanticAnalyzeStrategy 调用 + AppError
│   └── Strategy.ts       # 从 SemanticAnalyzeStrategy.ts 迁移（后续阶段）
├── data/
│   ├── Store.ts          # 新建：局部 Zustand Store（Step5State）
│   └── Repository.ts     # 新建：match_results 表读写（后续阶段）
└── __tests__/
    ├── Service.test.ts
    ├── View.test.tsx
    └── Store.test.ts
```

### 4.2 本次迁移范围（Phase 4 即刻执行）

1. **创建 types.ts** — Step5Input/Output/MatchResult/StepShotMatchingProps
2. **创建 index.ts** — 仅导出公共类型
3. **创建 frontend/Container.tsx** ← StepShotMatching.tsx
4. **创建 frontend/View.tsx** ← StepShotMatchingView.tsx
5. **旧文件 @deprecated 重导出**
6. **修复 StepPanel.tsx 导入路径**
7. **tsc --noEmit 验证**
8. **追加迁移记录**

### 4.3 后续阶段

- 后端 Strategy 迁移（SemanticAnalyzeStrategy.ts → backend/Strategy.ts）
- 局部 Store 创建（data/Store.ts）
- Repository 持久化
- i18n 全量对齐
- 补测试

---

## 5. 迁移记录

### 2026-07-04 — Phase 4 迁移完成

按 step3-script 样板完成 step5-match 模块化迁移。

**创建的新文件（4 个）**：

| 文件 | 状态 | 说明 |
|------|------|------|
| `types.ts` | ✅ 新建 | 按 §3.3.6 定义 Step5Input/Output/MatchResult/StepShotMatchingProps |
| `index.ts` | ✅ 新建 | 仅导出 types（Step5Input/Output/MatchResult/StepShotMatchingProps） |
| `frontend/Container.tsx` | ✅ 新建 | 从旧 StepShotMatching.tsx 提取 |
| `frontend/View.tsx` | ✅ 新建 | 从旧 StepShotMatchingView.tsx 提取 |

**旧文件 @deprecated 重导出（2 个）**：

| 文件 | 状态 |
|------|------|
| `renderer/.../steps/StepShotMatching.tsx` | ✅ 替换为重导出 |
| `renderer/.../steps/containers/StepShotMatchingView.tsx` | ✅ 替换为重导出 |

**消费者修复**：

| 文件 | 变更 |
|------|------|
| `StepPanel.tsx` | 导入路径 `'./steps/StepShotMatching'` → `'../../../../../modules/pipeline/step5-match/frontend/Container'` |

**验证结果**：`tsc --noEmit` 零错误通过
