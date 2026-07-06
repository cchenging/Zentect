# export-srt 子模块分析文档

> 生成日期：2026-07-04
> 对应架构规格：§3.6.2

## 1. 现状概览

| 项目 | 说明 |
|------|------|
| 现有文件 | 无（全新子模块） |
| 消费者 | 暂无（需在 ExportService 中新增方法） |
| IPC 通道 | 需新增 `export:srt` |
| 依赖 | `fs`、`shared/types` (AsrLine 接口) |

## 2. 规格要求（§3.6.2）

- 输入：`SrtExportInput { asrLines: AsrLine[]; outputPath: string; }`
- 输出：UTF-8 编码的 .srt 文件
- 格式：标准 SRT（序号 + 时间范围 + 文本 + 空行）

```
1
00:00:01,000 --> 00:00:03,500
第一句台词

2
00:00:04,000 --> 00:00:06,000
第二句台词
```

## 3. 迁移策略

| 步骤 | 操作 |
|------|------|
| 1 | 创建 `types.ts`：定义 `SrtExportInput` |
| 2 | 创建 `backend/Service.ts`：实现 `SrtExportService`，纯函数（无副作用除 fs.writeFileSync） |
| 3 | 创建 `index.ts`：只导出接口和 Service |
| 4 | 后续在 ExportService 中新增 `exportSrt` 方法引用此模块 |

## 4. 注意事项
- AsrLine 类型在 `shared/types/index.ts` 中目前未定义（原项目 ASR 结果直接内联），需确认使用 `{ start: string; end?: string; text: string }` 形状
- 时间格式：`start`/`end` 可能是 "MM:SS" 或 "HH:MM:SS" 格式，需兼容处理
- SRT 要求毫秒格式 "HH:MM:SS,mmm"
