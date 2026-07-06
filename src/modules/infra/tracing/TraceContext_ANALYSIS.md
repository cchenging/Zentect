# TraceContext 模块分析

## 基本信息
- **源路径**: `src/main/core/TraceContext.ts`
- **行数**: 107
- **类型**: 纯逻辑工具类（全静态方法）
- **Electron 依赖**: 无

## 功能描述
全链路追踪上下文，为 IPC 调用、Pipeline 执行、API 请求分配唯一 traceId：
- `startTrace` / `endTrace`: 创建和结束追踪
- `startSpan` / `endSpan`: 在追踪内创建子 Span
- `getTraceId`: 获取当前追踪 ID
- `getSpanDuration`: 查询 Span 耗时
- `enrichLog`: 为日志添加 `[trace:xxx]` 前缀

## 依赖分析
| 依赖 | 来源 | 说明 |
|---|---|---|
| `randomUUID` | Node.js `crypto` 标准库 | 无第三方依赖 |

> 零外部文件依赖，完全自包含。

## 消费者分析（共 2 个，含测试）
| 消费者 | 当前导入 | 迁移后需改为 |
|---|---|---|
| `src/main/engine/SimplePipelineRunner.ts` | `import { TraceContext } from '../core/TraceContext'` | `../../infra/tracing/TraceContext` |
| `src/main/core/__tests__/TraceContext.test.ts` | `import { TraceContext } from '../TraceContext'` | `../../../infra/tracing/TraceContext` ? 或迁测试至 `src/infra/tracing/__tests__/` |

## 测试文件处置
`src/main/core/__tests__/TraceContext.test.ts` 建议随模块一同迁移到 `src/infra/tracing/__tests__/TraceContext.test.ts`，保持模块自包含。

## 迁移评估
| 维度 | 结论 |
|---|---|
| Electron 依赖 | 无，可安全迁出 main/core |
| 外部依赖 | 零，完全自包含 |
| 消费者数量 | 1 个生产 + 1 个测试 |
| 迁移风险 | 极低 |
| 建议目标 | `src/infra/tracing/TraceContext.ts` |
