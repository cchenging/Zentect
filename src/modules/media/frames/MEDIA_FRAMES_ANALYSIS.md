# media-frames 模块分析报告

> 日期：2026-07-04
> 版本：v1.0
> 架构：Zentect v1.0 模块化架构

---

## 1. 搜索范围

| 搜索路径 | 匹配模式 | 结果 |
|---|---|---|
| `src/main/engine/media/` | `*Command*` `*Frame*` `*Extract*` | FFmpegCommandBuilder.ts、FrameWindowBuilder.ts、VideoProcessor.ts、VisionProcessor.ts |
| `src/main/engine/strategies/` | `*Extract*` | VisionExtractStrategy.ts |
| `src/main/controllers/` | `*Media*` | MediaController.ts（消费者） |
| `src/main/engine/` | `*Pipeline*` | ExtractionPipeline.ts（消费者） |
| `src/main/engine/` | `*Engine*` | mediaEngine.ts（消费者） |

---

## 2. 核心文件分析

### 2.1 FFmpegCommandBuilder.ts（436行）

**职责**：FFmpeg 命令行参数的结构化构建器。

**抽帧相关组件**：

| 组件 | 原位置 | 迁移状态 |
|---|---|---|
| `FrameStrategy` 类型 | L23 | → `src/modules/media/frames/types.ts` |
| `ExtractConfig` 接口 | L26-38 | → 内化为 `backend/Strategy.ts` 内部类型 |
| `VideoFilter` 基类 | L77-79 | → `backend/Strategy.ts` |
| `FilterChain` | L82-95 | → `backend/Strategy.ts` |
| `FpsFilter` | L98-103 | → `backend/Strategy.ts` |
| `KeyframeSelectFilter` | L106-108 | → `backend/Strategy.ts` |
| `SceneSelectFilter` | L111-117 | → `backend/Strategy.ts` |
| `VlmOptimizedSelectFilter` | L120-133 | → `backend/Strategy.ts` |
| `ScaleFilter` | L137-146 | **保留**（封面生成复用） |
| `FFmpegCommandBuilder` 类 | L149-271 | **保留**（封面生成 + ffprobe 复用） |
| `buildExtractCommand` | L288-408 | → `backend/Strategy.ts` |
| `buildCoverCommand` | L410-436 | **保留** |
| `buildProbeCommand` | L437-460 | **保留** |

### 2.2 VideoProcessor.ts（332行 → 302行）

**职责**：视频处理静态工具类。

| 方法 | 迁移状态 |
|---|---|
| `extractMetadata()` | **保留**（元数据提取非抽帧职责） |
| `probeVideo()` | → `FrameExtractionService.probeVideo()` |
| `generateCover()` | **保留**（封面生成非抽帧职责） |
| `extractFrames()` | → `FrameExtractionService.extractFrames()`，旧方法 @deprecated 委托 |

### 2.3 FrameWindowBuilder.ts（50行）

**职责**：滑动窗口构建器，用于将连续帧按时间窗口分组。

**迁移状态**：**未迁移**。该文件属于 pipeline 层的帧分组逻辑，不在 media-frames 模块职责范围内。 `VisionExtractStrategy.ts` 消费此模块。

### 2.4 VisionProcessor.ts（208行）

**职责**：旧版抽帧逻辑（`extractKeyframes`），已被 `VideoProcessor.extractFrames` 取代。

**迁移状态**：**未迁移**。该文件是历史遗留代码，可考虑后续清理。

### 2.5 VisionExtractStrategy.ts（364行）

**职责**：VLM 逐帧分析管线策略，调用 `FFmpegCommandBuilder` + `FrameWindowBuilder` 组合完成 VLM 分析。

**迁移状态**：**未迁移**。该文件属于 pipeline 层，消费 media-frames 模块，不在本次迁移范围。

---

## 3. 消费者分析

| 文件 | 引用内容 | 迁移后状态 |
|---|---|---|
| `MediaController.ts` | `VideoProcessor.extractFrames` + `FrameStrategy` | import 已更新到新模块 |
| `ExtractionPipeline.ts` | `VideoProcessor.extractFrames` | 通过 @deprecated 委托正常工作 |
| `mediaEngine.ts` | `VideoProcessor.extractFrames` | 通过 @deprecated 委托正常工作 |

---

## 4. 迁移后目录结构

```
src/modules/media/frames/
├── types.ts                  # 接口契约（FrameStrategy、FrameExtractInput/Output、FRAME_STRATEGIES）
├── index.ts                  # 模块入口
├── MODULE.md                 # 功能规格文档
├── backend/
│   ├── Service.ts            # FrameExtractionService（抽帧执行 + 前置探针 + 自适应参数）
│   └── Strategy.ts           # 4种策略的滤镜类 + buildExtractCommand
└── __tests__/                # 测试目录（待实现）
```

---

## 5. 类型检查结果

```
pnpm tsc --noEmit → RC=0，零错误
```
