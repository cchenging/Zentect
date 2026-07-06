# HttpClient 模块分析

## 基本信息
- **源路径**: `src/main/core/HttpClient.ts`
- **行数**: 125
- **类型**: 纯逻辑工具类
- **Electron 依赖**: 无

## 功能描述
通用 HTTP 客户端封装，基于 Node.js 原生 `fetch`：
- 支持 POST / GET，JSON 自动序列化/反序列化
- 可配置 baseURL、超时、重试次数、重试间隔
- AbortController 实现超时控制
- 静态单例 + 静态桥梁方法，兼容 `HttpClient.post()` / `HttpClient.get()` 直接调用

## 依赖分析
| 依赖 | 来源 | 是否已迁入 infra |
|---|---|---|
| `AppLogger` | `./AppLogger` (同级) | 否，仍在 `src/main/core/` |
| `LOG_TAGS` | `../../infra/logger/LogConstants` | 是 |
| `fetch` | Node.js 18+ global | N/A（运行时环境） |

> 唯一同级依赖是 `AppLogger`。迁移后 import 路径需更新为 `../logger/AppLogger` 或将 AppLogger 也迁入 infra。

## 消费者分析（共 2 个，不含自身测试）
| 消费者 | 当前导入 | 迁移后需改为 |
|---|---|---|
| `src/main/engine/LocalAiGateway.ts` | `import { HttpClient } from '../core/HttpClient'` | `../../infra/http/HttpClient` |
| `src/main/engine/media/VisionProcessor.ts` | `import { HttpClient } from '../../core/HttpClient'` | `../../../infra/http/HttpClient` |

## 迁移评估
| 维度 | 结论 |
|---|---|
| Electron 依赖 | 无，可安全迁出 main/core |
| 同级依赖 | 仅 AppLogger，需处理迁移后路径 |
| 消费者数量 | 2 个，影响面小 |
| 迁移风险 | 低 |
| 建议目标 | `src/infra/http/HttpClient.ts` |
