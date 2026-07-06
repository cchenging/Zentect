---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 9b6f801ad58644f2fa7e1baf0333ffda_8997a65a776411f1a7da5254006c9bbf
    ReservedCode1: AoZWcsWr92m8kBpGzXTEfrakXZDXXD4kKcbbOk3O63/JYjomEEP74oZwRx4LHIevs2Sk3gh+42JpfbchI9igxrtJR/D635BhI+gxZTC8kRxSXhyXVMTYBf64qFhVM2MvbTnEGa4WrALPNHY8mMl5t3Wk0+pD3ocDGDvD2oSJBqnS728Fd4zpySzJojg=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 9b6f801ad58644f2fa7e1baf0333ffda_8997a65a776411f1a7da5254006c9bbf
    ReservedCode2: AoZWcsWr92m8kBpGzXTEfrakXZDXXD4kKcbbOk3O63/JYjomEEP74oZwRx4LHIevs2Sk3gh+42JpfbchI9igxrtJR/D635BhI+gxZTC8kRxSXhyXVMTYBf64qFhVM2MvbTnEGa4WrALPNHY8mMl5t3Wk0+pD3ocDGDvD2oSJBqnS728Fd4zpySzJojg=
---

# Phase 2: Home 模块分析

## 架构文档目标

```
src/modules/home/
├── types.ts              # 接口契约（ProjectRecord, HomeListInput/Output）
├── index.ts              # 模块入口
├── frontend/
│   ├── Container.tsx     # 读 Store / 调 IPC，传 Props 给 View
│   ├── View.tsx          # 纯 Props 组件
│   ├── components/       # ProjectCard, DeleteModal, RenameModal
│   └── hooks/            # useProjectManager, useWorkflowImport
├── backend/
│   └── Service.ts        # 业务逻辑
├── data/
│   ├── Store.ts          # 局部 Store
│   └── Repository.ts     # DB 读写
└── __tests__/
```

## 当前代码分布

### 前端（renderer/src/pages/home/）
| 文件 | 行数 | 角色 |
|------|------|------|
| `index.tsx` | 251 | Home 页面（Container+View 混合） |
| `types.ts` | 12 | ProjectRecord 类型 |
| `components/ProjectCard.tsx` | 155 | 项目卡片 |
| `components/DeleteModal.tsx` | ~80 | 删除确认弹窗 |
| `components/RenameModal.tsx` | ~110 | 重命名弹窗 |
| `hooks/useProjectManager.ts` | 151 | 项目 CRUD + 状态管理 |
| `hooks/useWorkflowImport.ts` | ~90 | 工作流导入 |

### 后端（main/）
| 文件 | 行数 | 角色 |
|------|------|------|
| `controllers/ProjectController.ts` | 147 | IPC 处理注册 |
| `services/ProjectService.ts` | 345 | 核心业务逻辑 |
| `database/repositories/ProjectRepository.ts` | 20925 | DB CRUD |
| `database/queries/ProjectQueries.ts` | 6147 | SQL 查询 |

## 迁移策略（已完成 ✓）

前端已迁入 `src/modules/home/`。后端（ProjectService / ProjectRepository）与 main/ 生态系统深度耦合（IpcRouter、PathManager、SQLiteConnection），暂留 main/。

### 已完成步骤

**Step 1：目录结构** ✓
```
src/modules/home/
├── types.ts                          # ProjectRecord, Project, HomeListInput/Output
├── index.ts                          # 模块入口
├── HOME_ANALYSIS.md                  # 本文档
├── frontend/
│   ├── Container.tsx                  # 持有 State/Hooks，传递 Props 给 View
│   ├── View.tsx                       # 纯 Props 渲染组件
│   ├── components/
│   │   ├── ProjectCard.tsx
│   │   ├── DeleteModal.tsx
│   │   └── RenameModal.tsx
│   └── hooks/
│       ├── useProjectManager.ts
│       └── useWorkflowImport.ts
```

**Step 2：Container / View 分离** ✓
- `Container.tsx`：持有 state（renameVisible / deleteVisible / viewMode / searchOpen），调用 hooks（useProjectManager / useWorkflowImport），传递 props 给 View
- `View.tsx`：纯渲染组件，无任何 Store/API/Hooks 依赖，所有数据和回调通过 HomeViewProps 传入

**Step 3：旧文件 @deprecated 重导出** ✓
- `src/renderer/src/pages/home/index.tsx` → `export { HomeContainer as Home } from '../../../../modules/home/index'`

**Step 4：App.tsx 兼容** ✓
- 旧 lazy import `import('./pages/home').then(m => ({ default: m.Home }))` 通过重导出链自动兼容，无需修改

**Step 5：tsc 验证** 待执行

## 依赖分析

### 前端组件依赖（外部）
| 依赖 | 来源 | 说明 |
|------|------|------|
| `ParticleEngine` | `renderer/src/components/` | 粒子背景，全局组件 |
| `AppIcon` | `renderer/src/components/` | 应用图标，全局组件 |
| `DropdownMenu` | `renderer/src/components/ui/` | shadcn 组件 |
| `useI18n` | `renderer/src/store/` | 全局 i18n Store |
| `AppNotifier` | `renderer/src/core/` | 全局通知 |
| `FrontendLogger` | `renderer/src/utils/` | 全局日志 |

> 这些全局依赖横跨 renderer，在 home 模块迁移后 import 路径需上探 `../../../renderer/src/...`，较为丑陋。建议后续将这些全局组件也模块化。

## 风险评估

| 维度 | 结论 |
|------|------|
| 前端文件变更 | 7 个文件迁移 + 2 个拆分（Container/View） |
| 后端影响 | 无（暂留 main/） |
| 消费者影响 | App.tsx 中 1 处 lazy import |
| 风险 | 低 |
*（内容由AI生成，仅供参考）*
