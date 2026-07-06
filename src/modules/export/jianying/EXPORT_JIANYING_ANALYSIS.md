# export-jianying 子模块分析文档

> 生成日期：2026-07-04
> 对应架构规格：§3.6.1

## 1. 现状概览

| 项目 | 说明 |
|------|------|
| 现有文件 | `src/main/engine/export/LocalExporter.ts`、`src/main/engine/export/JianyingCompiler.ts` |
| 消费者 | `src/main/services/ExportService.ts` → `src/main/controllers/ExportController.ts` |
| IPC 通道 | `EXPORT_LOCAL_VIDEO`、`EXPORT_JIANYING` |
| 依赖 | `electron` (app.getPath)、`fs`、`path`、`crypto`、`shared/types` (Shot 接口) |

## 2. 现有代码分析

### LocalExporter.ts (53行)
- 职责：确定剪映草稿目录 → 创建专属文件夹 → 调用 JianyingCompiler.compile → 写入 draft_content.json + draft_meta.json
- 耦合点：依赖 `app.getPath('home')` (Electron API)，依赖 `JianyingCompiler`
- 问题：混合了路径解析（Electron依赖）和文件写入，未按模块化拆分

### JianyingCompiler.ts (138行)
- 职责：将 Shot[] 编译为剪映 4 轨（视频/BGM/TTS/字幕）草稿 JSON
- 格式：version 6，微秒时间单位，支持 BGM 降音铺底（volume 0.3）
- 依赖：`crypto` (UUID)、`shared/types` (Shot 接口)

### ExportService.ts (43行)
- 职责：IPC 服务层，封装 exportVideo / exportToJianYing
- 依赖：`LocalExporter`、`AppLogger`、`ProjectRepository`

## 3. 迁移策略

| 步骤 | 操作 |
|------|------|
| 1 | 创建 `types.ts`：定义 `JianyingExportInput` / `JianyingExportOutput`（匹配 §3.6.1） |
| 2 | 创建 `backend/Service.ts`：收编 JianyingCompiler.compile 逻辑为 `JianyingExportService` |
| 3 | 创建 `index.ts`：只导出接口和 Service |
| 4 | 旧文件标记 @deprecated，重导出到新模块 |
| 5 | 修复 ExportService.ts 消费者，改为引用新模块 |
| 6 | tsc --noEmit 验证 |

## 4. 注意事项
- JianyingCompiler 中的 `Shot` 类型来自 `../../../shared/types`，新模块需更新相对路径
- formatTextContent 是私有辅助方法，一并迁入 Service
- 旧 JianyingCompiler.ts 保留为 @deprecated 重导出，不删除
