# Media-Import 模块迁移分析报告

> **日期**: 2026-07-04  
> **架构基准**: §3.5.1 media-import 规格  
> **迁移状态**: ✅ 完成

---

## 1. 源文件分析

### 1.1 旧代码分布

| 源文件 | 行数 | 职责 | 迁移去向 |
|--------|------|------|----------|
| `src/main/services/MediaService.ts` | 243 | 导入/转码/封装/缩略图/删除 | → `backend/ImportService.ts` |
| `src/main/database/repositories/MediaRepository.ts` | 118 | SQLite CRUD + Agent上下文 | → `data/MediaRepository.ts` |
| `src/main/database/queries/MediaQueries.ts` | 114 | SQL语句统一管理 | → `data/MediaQueries.ts` |
| `src/main/controllers/MediaController.ts` | 220 | IPC路由注册 | 保持原位（适配新导入路径） |
| `src/renderer/src/pages/editor/.../useStepRunner.ts` | ~300 | 导入触发UI逻辑 | → `frontend/useMediaImport.ts` (提取) |
| `src/shared/types/index.ts` | 156 | 共享MediaItem类型 | MediaItem保留共享，模块自有类型独立 |

### 1.2 消费者导入分析

| 消费者 | 旧导入 | 新路径状态 |
|--------|--------|------------|
| `main/index.ts` | MediaController | 无需变更（MediaController保持原位） |
| `main/core/JobScheduler.ts` | MediaRepository | ✅ 通过 @deprecated 重导出兼容 |
| `main/engine/AIEngine.ts` | MediaRepository | ✅ 同上 |
| `main/engine/mediaEngine.ts` | MediaRepository | ✅ 同上 |
| `main/engine/ExtractionPipeline.ts` | MediaEngine | ✅ 未受影响 |
| `main/engine/media/MediaLanguageDetector.ts` | 媒体类型 | ✅ 未受影响 |
| `main/services/AIService.ts` | MediaRepository | ✅ 同上 |
| `renderer/src/api/index.ts` | shared/types MediaItem | ✅ 共享类型不变 |
| 前端 30+ 文件 | shared/types MediaItem | ✅ 共享类型不变 |

---

## 2. 与规格的差距分析

### 2.1 类型定义对比

| 规格项 | 规格定义 | 实现状态 |
|--------|---------|---------|
| `ImportInput` | `{ projectId, filePaths }` | ✅ 完全一致 |
| `ImportOutput` | `{ mediaItems: MediaItem[] }` | ✅ 完全一致 |
| `MediaItem.type` | `'video' \| 'audio' \| 'frame' \| 'video_chunk'` | ✅ 完全一致 |
| `MediaItem.status` | `'importing' \| 'parsed' \| 'transcoding'` | ✅ 完全一致 |
| `MediaRow` (新增) | 扩展字段 projectId/frames/extracted* | ✅ 新增，用于DB行映射 |

### 2.2 交互逻辑对比

| 规格要求 | 实现 |
|----------|------|
| 1. 选文件 → 立即创建记录返回前端 → 视频马上能播放 | ✅ `importMedia` 同步插入DB后立即返回 |
| 2. 后台异步：ffprobe提取元数据 + ffmpeg生成封面 | ✅ `processMediaInBackground` 异步执行 |
| 3. 完成后通过IPC事件 `media:updated` 通知前端 | ✅ `notifyFrontend` 通过 BrowserWindow.webContents.send |
| 4. HEVC/非原生格式 → 后台异步转码H.264 MP4 | ✅ `detectHevcCodec` + `transcodeAsync` |
| 5. 转码完成后更新filePath并通知前端 | ✅ transcodeAsync close回调中更新 |

### 2.3 支持格式对比

| 规格 | 实现 |
|------|------|
| 原生播放: mp4, webm, ogg | ✅ mp4/webm 原生, ogg 未明确但扩展名列表已支持 |
| 需转码: mkv, avi, mov, wmv, flv, ts, rmvb, rm, 3gp, vob | ✅ 完全一致 |
| 音频: mp3, wav, aac, flac, m4a | ✅ 完全一致 |

### 2.4 i18n 文案

| key | 中文 | 状态 |
|-----|------|------|
| `media.import.success` | 导入成功 | ⚠️ 引用 DICT 字典，由 Controller 层展示 |
| `media.import.fail` | 导入失败 | ⚠️ 同上 |
| `media.import.transcoding` | 正在转码... | ✅ ImportService 日志中已使用对应 LogTag |
| `media.import.transcodeDone` | 转码完成 | ✅ 同上 |
| `media.import.formatUnsupported` | 不支持的格式 | ⚠️ 由调用方校验 |

---

## 3. 模块目录结构

```
src/modules/media/import/
├── types.ts              (946B)  ImportInput / ImportOutput / MediaItem / MediaRow
├── index.ts              (361B)  模块公共导出
├── frontend/
│   └── useMediaImport.ts (1.6KB) 导入触发 Hook
├── backend/
│   └── ImportService.ts  (9.4KB) 导入/转码/封面/元数据
├── data/
│   ├── MediaRepository.ts (6.1KB) SQLite CRUD
│   └── MediaQueries.ts   (2.9KB) SQL 语句定义
├── MODULE.md → ANALYSIS.md（本文件即为分析文档）
└── __tests__/（待实现）
```

---

## 4. 迁移动作清单

| # | 动作 | 文件 | 状态 |
|---|------|------|------|
| 1 | 新建 | `src/modules/media/import/types.ts` | ✅ |
| 2 | 新建 | `src/modules/media/import/data/MediaQueries.ts` | ✅ |
| 3 | 新建 | `src/modules/media/import/data/MediaRepository.ts` | ✅ |
| 4 | 新建 | `src/modules/media/import/backend/ImportService.ts` | ✅ |
| 5 | 新建 | `src/modules/media/import/frontend/useMediaImport.ts` | ✅ |
| 6 | 新建 | `src/modules/media/import/index.ts` | ✅ |
| 7 | @deprecated 重导出 | `src/main/services/MediaService.ts` | ✅ |
| 8 | @deprecated 重导出 | `src/main/database/repositories/MediaRepository.ts` | ✅ |
| 9 | @deprecated 重导出 | `src/main/database/queries/MediaQueries.ts` | ✅ |
| 10 | tsc --noEmit | 全量类型检查 | ✅ 零错误 |

---

## 5. 待后续处理

| 事项 | 优先级 | 说明 |
|------|--------|------|
| ImportService 的 pathManager/videoProcessor 仍作为参数传入 | 中 | 需等 media-frames 模块建立后统一注入 |
| frontend/useMediaImport 尚未被 useStepRunner 引用 | 低 | 需在各消费者中逐步替换旧调用方式 |
| __tests__ 待补充 | 中 | 导入流程单元测试 |
| media:import IPC 通道仍由 MediaController 注册 | 中 | 可考虑后续将 IPC 注册收敛到模块内 |
