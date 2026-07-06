# media-audio 模块分析报告

> 日期：2026-07-04
> 版本：v1.0
> 架构基准：§3.5.3 media-audio

---

## 1. 搜索范围与结果

| 搜索路径 | 匹配模式 | 命中文件 |
|---|---|---|
| `src/` | `*AudioSeparat*`, `*audio*separate*` | AudioSeparateStrategy.ts, AudioSeparateParser.ts, AudioSeparationSubStep.tsx |
| `src/main/engine/media/` | `AudioProcessor*` | AudioProcessor.ts（核心工具类） |
| `src/` (全文) | `AudioSeparate\|audio-separate` | 10 个文件引用 |

---

## 2. 源文件清单

### 2.1 核心策略文件

| 文件 | 行数 | 职责 | 迁移处置 |
|---|---|---|---|
| `src/main/engine/strategies/AudioSeparateStrategy.ts` | 68 | 人声分离管线策略（extends BaseNodeStrategy） | @deprecated，委托给新 Service |
| `src/renderer/src/core/parsers/AudioSeparateParser.ts` | 27 | 管线节点解析器（node→PipelineTask） | @deprecated（管线解析器非媒体模块职责） |
| `src/renderer/.../AudioSeparationSubStep.tsx` | 33 | 步骤1的音频分离UI子组件 | 保留原位（纯UI组件，非业务逻辑） |

### 2.2 依赖工具类

| 文件 | 行数 | 职责 | 迁移处置 |
|---|---|---|---|
| `src/main/engine/media/AudioProcessor.ts` | 167 | 音频处理工具（extractAudioForASR, separateVocals, separateVocalsBgm, separateAudio） | **保留原位**（底层引擎工具，非模块职责） |

---

## 3. 消费者分析

| 消费者文件 | 导入内容 | 迁移后状态 |
|---|---|---|
| `src/main/engine/PipelineEngine.ts` | `AudioSeparateStrategy` (L7, L32, L425) | ✅ 策略类保留旧位置（@deprecated 委托） |
| `src/main/engine/SimplePipelineRunner.ts` | `AudioSeparateStrategy` (L15, L247) | ✅ 同上 |
| `src/renderer/src/core/parsers/index.ts` | `AudioSeparateParser` (L3, L15) | ✅ 解析器保留旧位置 |
| `src/renderer/src/core/parsers/__tests__/parsers.test.ts` | `AudioSeparateParser` (L4, L39-56) | ✅ 测试保持不变 |
| `src/main/engine/strategies/ASRStrategy.ts` | 注释中引用 `audio-separate` (L27) | ✅ 无导入，无需变更 |
| `src/main/engine/ExtractionPipeline.ts` | `AudioProcessor` (L3, L148, L157) | ✅ AudioProcessor 未迁移，无需变更 |
| `src/main/core/EngineStateGuard.ts` | 注释中引用 `audio-separate` (L13) | ✅ 无导入，无需变更 |
| `src/main/core/__tests__/EngineStateGuard.test.ts` | 字符串字面量 `audio-separate` (L25, L47, L55) | ✅ 测试数据，无需变更 |

---

## 4. 与规格对比（§3.5.3）

### 4.1 接口对比

| 规格项 | 规格定义 | 旧实现 | 新实现 |
|---|---|---|---|
| `AudioSeparateInput.videoPath` | `string` | `AudioSeparateInput.mediaPath` (策略) | ✅ 对齐规格 |
| `AudioSeparateInput.engine` | `string` | `engine?: 'spleeter' \| 'uvr5'` (策略) | ✅ 对齐规格 |
| `AudioSeparateOutput.vocalsPath` | `string` | `vocalPath` (策略) | ✅ `vocalsPath` 对齐 |
| `AudioSeparateOutput.bgmPath` | `string` | `bgmPath` (策略) | ✅ 一致 |

### 4.2 文案覆盖

| i18n key | 中文 | 状态 |
|---|---|---|
| `media.audio.separating` | 正在分离音频... | ⚠️ Service 内部通过 onProgress 回调对外暴露 |
| `media.audio.separated` | 音频分离完成 | ⚠️ 同上 |
| `media.audio.fail` | 音频分离失败 | ⚠️ 同上 |
| `media.audio.vocals` | 人声台词 | ✅ 输出字段 `vocalsPath` |
| `media.audio.bgm` | 背景音乐 | ✅ 输出字段 `bgmPath` |

---

## 5. 迁移后目录结构

```
src/modules/media/audio/
├── types.ts              # AudioSeparateInput / AudioSeparateOutput
├── index.ts              # 模块公共导出
├── backend/
│   └── Service.ts        # AudioSeparationService（音频分离核心逻辑）
├── MEDIA_AUDIO_ANALYSIS.md  # 本文件
└── __tests__/（待实现）
```

---

## 6. 迁移动作清单

| # | 动作 | 文件 | 状态 |
|---|------|------|------|
| 1 | 新建 | `src/modules/media/audio/types.ts` | ✅ |
| 2 | 新建 | `src/modules/media/audio/backend/Service.ts` | ✅ |
| 3 | 新建 | `src/modules/media/audio/index.ts` | ✅ |
| 4 | @deprecated | `src/main/engine/strategies/AudioSeparateStrategy.ts` | ✅ |
| 5 | @deprecated | `src/renderer/src/core/parsers/AudioSeparateParser.ts` | ✅ |
| 6 | 修复消费者 | PipelineEngine.ts / SimplePipelineRunner.ts 导入路径 | ✅ |
| 7 | tsc --noEmit | 全量类型检查 | ✅ RC=0 零错误 |
