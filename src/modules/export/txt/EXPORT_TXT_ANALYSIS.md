# export-txt 子模块分析文档

> 生成日期：2026-07-04
> 对应架构规格：§3.6.3

## 1. 现状概览

| 项目 | 说明 |
|------|------|
| 现有文件 | 无（全新子模块） |
| 消费者 | 暂无（需在 ExportService 中新增方法） |
| IPC 通道 | 需新增 `export:txt` |
| 依赖 | `fs`、`shared/types` (ScriptParagraph 接口) |

## 2. 规格要求（§3.6.3）

- 输入：`TxtExportInput { scriptParagraphs: ScriptParagraph[]; outputPath: string; }`
- 输出：UTF-8 编码的 .txt 文件
- 内容：完整解说文案，每段一行或分段

## 3. 迁移策略

| 步骤 | 操作 |
|------|------|
| 1 | 创建 `types.ts`：定义 `TxtExportInput` |
| 2 | 创建 `backend/Service.ts`：实现 `TxtExportService`，纯函数（无副作用除 fs.writeFileSync） |
| 3 | 创建 `index.ts`：只导出接口和 Service |
| 4 | 后续在 ExportService 中新增 `exportTxt` 方法引用此模块 |

## 4. 注意事项
- ScriptParagraph 类型在 `shared/types/index.ts` 中目前未定义，需确认使用 `{ id: string; shotId?: string; text: string; duration?: number; }` 形状
- 文案可能包含多段，按段落顺序串联写入
- UI 层（导出弹窗）暂不迁移，属于 editor 模块范围
