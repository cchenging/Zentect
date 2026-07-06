# settings/ai-config 分析文档

## 一、源文件清单

| 文件 | 位置 | 行数 | 职责 |
|------|------|------|------|
| ApiProfileRepository.ts | src/main/services/ | 105 | API配置CRUD（静态方法，支持加密字段） |
| ApiProfileController.ts | src/main/services/ | 45 | 注册9个IPC通道（含binding） |
| migrateApiProfiles.ts | src/main/services/ | 75 | 旧版settings表API Key迁移到api_profiles表 |
| ApiProfileManager.tsx | src/renderer/src/components/shared/ | 230 | 前端多配置管理UI（列表/新增/编辑/删除/激活/测试） |
| AITab.tsx | src/renderer/src/pages/settings/components/ | 427 | AI服务配置页（供应商卡片+管线映射+TTS配置） |

## 二、依赖关系

- ApiProfileRepository → DatabaseConnectionManager (SQLite)
- ApiProfileController → ApiProfileRepository + ProfileBindingRepository → ipcMain
- migrateApiProfiles → SettingsRepository + ApiProfileRepository
- ApiProfileManager.tsx → window.api.apiProfile (IPC)
- AITab.tsx → ApiProfileManager + window.api.apiProfile + window.api.profileBinding

## 三、与架构规格对照

| 规格项 | 现状 | 差距 |
|--------|------|------|
| ProviderConfig 接口 | 散落在 AITab.tsx 的 PROVIDERS 常量 | 无类型化导出 |
| ApiProfile 接口 | ApiProfileRepository.ts 有内联类型 | 无模块级 types.ts |
| AiConfigInput 接口 | 不存在 | 需按 §3.7.1 新建 |
| ApiProfileManager 多配置 | 已实现 | 无 |
| 测试连接 | 已实现 | 无 |
| 管线模型映射 | 在 AITab.tsx 中耦合 | 应拆分到 binding 子模块 |

## 四、迁移方案

1. types.ts：定义 ProviderConfig / ApiProfile / AiConfigInput 接口
2. backend/AiConfigService.ts：封装 API Profile CRUD + 测试连接（委托 ApiProfileRepository + SettingsService）
3. index.ts：统一导出
4. 旧 ApiProfileRepository.ts / ApiProfileController.ts 转 @deprecated 委托
5. ApiProfileManager.tsx 保留原地，import 更新到新模块
