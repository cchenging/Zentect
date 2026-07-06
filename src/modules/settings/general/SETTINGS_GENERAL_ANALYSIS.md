# settings/general 分析文档

## 一、源文件清单

| 文件 | 位置 | 行数 | 职责 |
|------|------|------|------|
| SettingsService.ts | src/main/services/ | 128 | getAll/getByKeys/setSetting/validatePath |
| SettingsRepository.ts | src/main/services/ | 155 | 加密存储/解密/safeDecrypt/migrateStaleEncryptedData |
| SettingsController.ts | src/main/services/ | 60 | settings:getAll/getByKeys/resetAll/validatePath IPC通道 |
| useSettingsManager.ts | src/renderer/src/pages/settings/hooks/ | 176 | Schema驱动的配置加载/更新/保存 + 测试连接 |
| GeneralTab.tsx | src/renderer/src/pages/settings/components/ | 190 | 通用设置UI（路径/主题/语言/GPU/危险区域） |
| HealthPage.tsx | src/renderer/src/pages/settings/components/ | 203 | 系统健康检查（6项） |

## 二、依赖关系

- SettingsService → SettingsRepository → DatabaseConnectionManager + crypto
- SettingsController → SettingsService → ipcMain
- useSettingsManager → API.system.getSetting/setSetting + API.ai.testNetwork/testTTS
- GeneralTab → useSettingsManager 传入 data/onUpdate

## 三、与架构规格对照

| 规格项 | 现状 | 差距 |
|--------|------|------|
| 项目存储位置 | GeneralTab 已实现 | 无 |
| 视频导出位置 | GeneralTab 已实现 | 无 |
| 剪映草稿位置 | GeneralTab 已实现 | 无 |
| 主题 | GeneralTab dark/light/system | 无 |
| 语言 | GeneralTab zh-CN/en | 无 |
| GPU加速 | GeneralTab Switch | 无 |
| 自动保存 | GeneralTab 3/5/10/30秒 | 规格为10/30/60秒 |
| Python路径 | 未实现 | 规格有但未实现 |
| TTS配置 | 在 AITab.tsx 中 | 规格建议在general下方 |
| 健康检查 | HealthPage.tsx 独立Tab | 已实现 |
| GeneralSettings 接口 | 未统一定义 | 需按 §3.7.4 新建 |

## 四、迁移方案

1. types.ts：定义 GeneralSettings / HealthCheckItem 等接口
2. backend/GeneralSettingsService.ts：封装通用设置CRUD（委托 SettingsService + SettingsRepository）
3. index.ts：统一导出
4. 旧 SettingsService.ts / SettingsRepository.ts / SettingsController.ts 转 @deprecated 委托
5. useSettingsManager.ts / GeneralTab.tsx import 更新
