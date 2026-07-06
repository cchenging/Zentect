# Editor 模块迁移记录

## Phase 6: 2026-07-05

### 迁移内容
将 editor 模块按架构文档 §3.4 规格迁移到 `src/modules/editor/`。

### 子模块结构

```
src/modules/editor/
├── MODULE.md                          # 本文件
├── shell/                             # §3.4.1 编辑器外壳
│   ├── types.ts                       # EditorShellInput/Output, StepInfo, MediaTab
│   ├── index.ts                       # 入口: TopBar, StepPanel, PipelineStatusBar, PropertyBar + 7 hooks + pipelineConstants
│   ├── frontend/
│   │   ├── components/
│   │   │   ├── TopBar.tsx             # 顶栏（Logo/项目名/导出/设置/窗口控制）
│   │   │   ├── StepPanel.tsx          # 步骤面板（1-5步骤导航+管线状态+属性栏+底部操作）
│   │   │   ├── PipelineStatusBar.tsx  # 管线状态条（进度+中止+错误提示）
│   │   │   └── PropertyBar.tsx        # 属性栏（角色/时长/语速/台词）
│   │   └── hooks/
│   │       ├── useEditorLogic.ts      # useEditorHydration / useEditorAutoSave / useSyncDaemon
│   │       ├── useStepRunner.ts       # handleStart / handleNextStep / handleVideoImport
│   │       ├── usePipelineOrchestrator.ts  # PipelineMode / executeStep
│   │       ├── usePipelineExecutor.ts
│   │       ├── useTaskProgress.ts
│   │       ├── useResizablePanel.ts
│   │       ├── useExtractionHandler.ts
│   │       └── useKeyboardShortcuts.ts
│   └── utils/
│       └── pipelineConstants.ts       # STEPS, MEDIA_TABS, CODE_TO_NAME 等
├── preview/                           # §3.4.2 视频预览播放器
│   ├── types.ts                       # PreviewInput/Output, PreviewCallbacks
│   ├── index.ts                       # 入口: PreviewMonitor(default), PlayerControls, VideoCanvas, formatTime
│   ├── frontend/
│   │   ├── View.tsx                   # PreviewMonitor — Props驱动，空状态或Player
│   │   └── components/
│   │       ├── Player.tsx             # 播放器容器（VideoCanvas + PlayerControls）
│   │       ├── PlayerControls.tsx     # 播放控制栏（播放/暂停/进度/缩放/画幅/音量/全屏）
│   │       └── VideoCanvas.tsx        # 视频画布
│   └── utils/
│       └── timeFormat.ts              # formatTime
└── storyboard/                        # §3.4.3 故事板（复用 step5-match）
    ├── types.ts                       # StoryboardInput/Output, ShotCardProps
    ├── index.ts                       # 入口: ShotCard
    └── frontend/
        └── components/
            └── ShotCard.tsx           # 镜头匹配卡片
```

### 已废弃的旧文件

以下文件已添加 `@deprecated` JSDoc 标记，指向新的模块路径：

| 旧路径 | 新路径 |
|--------|--------|
| `src/renderer/src/pages/editor/components/top-bar/index.tsx` | `src/modules/editor/shell/` → TopBar |
| `src/renderer/src/pages/editor/components/StepPanel.tsx` | `src/modules/editor/shell/` → StepPanel |
| `src/renderer/src/pages/editor/components/PipelineStatusBar.tsx` | `src/modules/editor/shell/` → PipelineStatusBar |
| `src/renderer/src/pages/editor/components/PropertyBar.tsx` | `src/modules/editor/shell/` → PropertyBar |
| `src/renderer/src/pages/editor/components/player/index.tsx` | `src/modules/editor/preview/` → Player |
| `src/renderer/src/pages/editor/components/player/PlayerControls.tsx` | `src/modules/editor/preview/` → PlayerControls |
| `src/renderer/src/pages/editor/components/player/VideoCanvas.tsx` | `src/modules/editor/preview/` → VideoCanvas |
| `src/renderer/src/pages/editor/components/storyboard/PreviewMonitor.tsx` | `src/modules/editor/preview/` → PreviewMonitor |
| `src/renderer/src/pages/editor/components/storyboard/ShotCard.tsx` | `src/modules/editor/storyboard/` → ShotCard |
| `src/renderer/src/pages/editor/hooks/useEditorLogic.ts` | `src/modules/editor/shell/` |
| `src/renderer/src/pages/editor/hooks/useStepRunner.ts` | `src/modules/editor/shell/` |
| `src/renderer/src/pages/editor/hooks/usePipelineOrchestrator.ts` | `src/modules/editor/shell/` |
| `src/renderer/src/pages/editor/hooks/usePipelineExecutor.ts` | `src/modules/editor/shell/` |
| `src/renderer/src/pages/editor/hooks/useTaskProgress.ts` | `src/modules/editor/shell/` |
| `src/renderer/src/pages/editor/hooks/useResizablePanel.ts` | `src/modules/editor/shell/` |
| `src/renderer/src/pages/editor/hooks/useExtractionHandler.ts` | `src/modules/editor/shell/` |
| `src/renderer/src/pages/editor/hooks/useKeyboardShortcuts.ts` | `src/modules/editor/shell/` |
| `src/renderer/src/pages/editor/utils/pipelineConstants.ts` | `src/modules/editor/shell/` |
| `src/renderer/src/pages/editor/utils/timeFormat.ts` | `src/modules/editor/preview/` |

### 消费者迁移

`src/renderer/src/pages/editor/index.tsx` 已将导入从旧路径切换到 `@modules/editor/{shell,preview}`。

### tsconfig 变更

- `tsconfig.web.json` 新增 `include: "src/modules/**/*"`
- 新增 `@modules/*` → `src/modules/*` 路径别名

### tsc 结果

- 修复前总错误: 278（含 pre-existing TS6307 项目引用错误）
- 修复后总错误: 273（仅 1 个 pre-existing `currentTime` 未使用警告属于本次文件）
- 迁移引入 0 个新错误

### 待办

- 模块内部 `../../../../../../renderer/src/...` 深度相对路径需统一替换为 `@renderer/` 别名
- step1-5 Container 组件（被 StepPanel 引用）尚未迁移到 modules 目录
- Store 迁移完成后，移除模块对旧 store 的直接依赖
