# Phase 5: settings 模块迁移记录

## 2026-07-04 — settings/ai-config / settings/binding / settings/models / settings/general 全部子模块迁移完成

### 迁移内容

| 子模块 | 新文件 | 来源 |
|--------|--------|------|
| **settings/ai-config** | `src/modules/settings/ai-config/types.ts` | 新建（规格 §3.7.1） |
| | `src/modules/settings/ai-config/backend/AiConfigService.ts` | 委托 `ApiProfileRepository` 现有实现 + PROVIDER_CONFIGS 常量 |
| | `src/modules/settings/ai-config/index.ts` | 新建 |
| | `src/modules/settings/ai-config/SETTINGS_AI_CONFIG_ANALYSIS.md` | 分析文档 |
| **settings/binding** | `src/modules/settings/binding/types.ts` | 新建（规格 §3.7.2） |
| | `src/modules/settings/binding/backend/BindingService.ts` | 委托 `ProfileBindingRepository` 现有实现 + PIPELINE_NODES |
| | `src/modules/settings/binding/index.ts` | 新建 |
| | `src/modules/settings/binding/SETTINGS_BINDING_ANALYSIS.md` | 分析文档 |
| **settings/models** | `src/modules/settings/models/types.ts` | 新建（规格 §3.7.3） |
| | `src/modules/settings/models/backend/ModelManagementService.ts` | 委托 `ModelService` + `ModelRepository` 现有实现 + toModelInfo() 转换器 |
| | `src/modules/settings/models/index.ts` | 新建 |
| | `src/modules/settings/models/SETTINGS_MODELS_ANALYSIS.md` | 分析文档 |
| **settings/general** | `src/modules/settings/general/types.ts` | 新建（规格 §3.7.4） |
| | `src/modules/settings/general/backend/GeneralSettingsService.ts` | 委托 `SettingsService` + `SettingsRepository` 现有实现 + toGeneralSettings() 转换器 |
| | `src/modules/settings/general/index.ts` | 新建 |
| | `src/modules/settings/general/SETTINGS_GENERAL_ANALYSIS.md` | 分析文档 |

### 旧文件处理

| 文件 | 状态 |
|------|------|
| `src/main/database/repositories/ApiProfileRepository.ts` | @deprecated，保持不变 |
| `src/main/database/repositories/ProfileBindingRepository.ts` | @deprecated，保持不变 |
| `src/main/database/repositories/ModelRepository.ts` | @deprecated，保持不变 |
| `src/main/database/repositories/SettingsRepository.ts` | @deprecated，保持不变 |
| `src/main/services/ModelService.ts` | @deprecated，保持不变 |
| `src/main/services/SettingsService.ts` | @deprecated，保持不变 |

### 消费者处理

依据 settings/media/export 模块的委托迁移策略，**零消费者 import 变更**：
- 所有现有消费者（ApiProfileController、SettingsController、LLMFactory、ProviderManager、PathManager、AIDaemon 等共 15+ 文件）继续从原路径 import
- 新代码通过 `src/modules/settings/<子模块>/index.ts` 引入类型 + 委托入口

### 验证

- `tsc --noEmit`: 跳过（沙箱无 Node 环境）
- 模块入口：4 个子模块的 `index.ts` 均只导出 `types.ts` 接口 + `backend/` 委托入口，符合 §1.3 通信规则
- @deprecated 标记：7 个旧文件类声明已添加 JSDoc @deprecated 注解
