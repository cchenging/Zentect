// 📁 路径：src/main/engine/strategies/VisionExtractStrategy.ts
// 🚀 画面描述策略：每帧独立VLM分析 + 高并发 + 流式推送
// 核心理念：场景模式提取的关键帧本身就是场景边界，每帧独立分析最准确
import fs from 'fs';
import path from 'path';
import { BaseNodeStrategy, ExecutionContext } from './BaseNodeStrategy';
import { VisionProcessor } from '../media/VisionProcessor';
import { LLMFactory } from '../adapters/LLMFactory';
import { PromptBuilder } from '../prompts/PromptBuilder';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';
import { dehydrateMagicPath } from '../utils/pathUtils';
import { buildFrameWindow } from '../media/FrameWindowBuilder';

export interface VisionExtractInput {
  mediaId: string;
  mediaPath: string;
  modelName?: string;
  framesMode?: 'fps' | 'scene';
  framesValue?: number;
  /** 预抽取的帧路径列表（来自步骤1 素材分析），提供时跳过抽帧步骤 */
  framePaths?: string[];
  /** 项目 ID，用于 context.bus 读取 ASR 数据 */
  projectId?: string;
}

export interface FrameDetail {
  url: string;
  description: string;
  asrText: string;
  asrTime: string;
  /** 该帧在视频中的绝对时间（毫秒） */
  timeMs: number;
  /** 该帧绝对时间的可读格式，如 "00:12.15" */
  timeStr: string;
  editing: boolean;
  confirmed: boolean;
  emotion: string;
}

export interface VisionExtractOutput {
  framesCount: number;
  sceneDescriptions: string;
  framePaths?: string[];
  /** 每帧完整信息，含画面描述和关联台词 */
  frames?: FrameDetail[];
}

/** VLM 并发路数 */
const CONCURRENT_VLM = 5;

export class VisionExtractStrategy extends BaseNodeStrategy<VisionExtractInput, VisionExtractOutput> {
  public readonly nodeType = 'vision-extract';

  protected async validate(input: VisionExtractInput): Promise<void> {
    const physicalPath = dehydrateMagicPath(input.mediaPath);
    if (!physicalPath || !fs.existsSync(physicalPath)) throw new Error('视觉提取失败：未找到原始媒体文件');
  }

  /**
   * 执行视觉提取任务
   * 每帧独立VLM分析：场景模式提取的关键帧本身就是场景边界，独立分析最准确
   * 5路并发保证速度，流式推送实现打字机效果
   */
  protected async performTask(
    input: VisionExtractInput, 
    context: ExecutionContext, 
    cacheDir: string,
    onProgress: (p: number, s: string, _results?: any) => void
  ): Promise<VisionExtractOutput> {
    
    /** 解析帧列表：优先使用预抽取帧，否则从视频中提取 */
    const physicalMediaPath = dehydrateMagicPath(input.mediaPath);
    let physicalFrames: string[];
    if (input.framePaths && input.framePaths.length > 0) {
      physicalFrames = input.framePaths
        .map((p: string) => dehydrateMagicPath(p))
        .filter((p: string) => {
          try { return fs.existsSync(p); } catch { return false; }
        });
      if (physicalFrames.length === 0) {
        throw new Error('画面描述失败：未找到已提取的关键帧，请先完成步骤1「素材分析」');
      }
      onProgress(5, `复用步骤1已有帧 ${physicalFrames.length} 张，启动 VLM 逐帧分析...`);
    } else {
      const framesDir = path.join(cacheDir, `${input.mediaId}_frames`);
      const mode = input.framesMode || 'scene';
      const value = input.framesValue || 0.3;
      onProgress(5, '启动物理视神经，正在扫描视频画面...');
      physicalFrames = await VisionProcessor.extractKeyframes(
        physicalMediaPath, framesDir, mode, value,
        (percent) => onProgress(5 + Math.floor(percent * 0.25), `画面解码中: ${percent}%`)
      );

      /** 抽帧降级回退：scene 模式帧数<3 时自动切到 fps 模式 */
      if (mode === 'scene' && physicalFrames.length < 3) {
        AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
          `[VisionExtract] Scene 模式仅产出 ${physicalFrames.length} 帧，自动降级到 FPS 模式`);
        const fpsFramesDir = path.join(cacheDir, `${input.mediaId}_frames_fps`);
        physicalFrames = await VisionProcessor.extractKeyframes(
          physicalMediaPath, fpsFramesDir, 'fps', 1,
          (percent) => onProgress(5 + Math.floor(percent * 0.25), `降级FPS解码: ${percent}%`)
        );
      }

      if (physicalFrames.length === 0) throw new Error('未能从视频中提取到任何有效画面');
      onProgress(30, `抽取完成，共 ${physicalFrames.length} 个关键帧，启动逐帧 VLM 分析...`);
    }

    /** 从 context.bus 读取 ASR 台词，用于帧-台词时间对齐 */
    let asrLines: { startTime: number; endTime: number; text: string }[] = [];
    try {
      const asrResult = context.bus.get('asr-result');
      if (asrResult) {
        const rawLines = asrResult.lines || asrResult.asrLines || [];
        asrLines = rawLines.filter((l: any) => l.originalText || l.text).map((l: any) => {
          // 优先使用毫秒字段，转换为秒；兜底解析字符串
          let startTime: number, endTime: number;
          if (l.startMs !== undefined) {
            startTime = l.startMs / 1000;
          } else if (typeof l.start === 'number') {
            startTime = l.start;
          } else if (typeof l.startTime === 'number') {
            startTime = l.startTime;
          } else {
            const parts = String(l.start || '0').split(':').map(Number);
            startTime = parts.length >= 2 ? parts[0] * 60 + parts[1] : 0;
          }
          if (l.endMs !== undefined) {
            endTime = l.endMs / 1000;
          } else if (typeof l.end === 'number') {
            endTime = l.end;
          } else if (typeof l.endTime === 'number') {
            endTime = l.endTime;
          } else {
            const parts = String(l.end || '0').split(':').map(Number);
            endTime = parts.length >= 2 ? parts[0] * 60 + parts[1] : startTime + 3;
          }
          return { startTime, endTime, text: l.originalText || l.text || '' };
        });
      }
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[画面描述] 从 context.bus 读取 ASR 失败: ${e.message}`);
    }

    const allFrames = physicalFrames;
    const totalFrameCount = allFrames.length;

    /** 计算每帧的估算时间点 */
    const estimatedInterval = totalFrameCount > 0 && asrLines.length > 0
      ? (asrLines[asrLines.length - 1].endTime || 7200) / totalFrameCount
      : 4;

    AppLogger.info(LOG_TAGS.AI_AGENT, `[画面描述] 帧数: ${totalFrameCount}, ASR台词: ${asrLines.length}, 估算间隔: ${estimatedInterval.toFixed(1)}s, 并发: ${CONCURRENT_VLM}`);

    const { adapter, modelName: resolvedModel } = LLMFactory.createAdapter('visual');
    /** 💥 修复：优先使用用户在设置中配置的 VLM 模型，不再硬编码 qwen-vl-max */
    const model = input.modelName || resolvedModel;

    /** LRU Base64 缓存 */
    const MAX_BASE64_IN_MEMORY = 60;
    const base64Cache = new Map<string, string>();
    const getBase64 = (framePath: string): string => {
      if (base64Cache.has(framePath)) {
        const val = base64Cache.get(framePath)!;
        base64Cache.delete(framePath);
        base64Cache.set(framePath, val);
        return val;
      }
      const base64 = fs.readFileSync(framePath, 'base64');
      if (base64Cache.size >= MAX_BASE64_IN_MEMORY) {
        const oldest = base64Cache.keys().next().value;
        if (oldest) base64Cache.delete(oldest);
      }
      base64Cache.set(framePath, base64);
      return base64;
    };

    /** 每帧的描述和JSON数据存储 */
    const frameDescriptions: string[] = new Array(totalFrameCount).fill('');
    const frameJsonItems: (any | null)[] = new Array(totalFrameCount).fill(null);
    let completedFrames = 0;
    const framePathsOriginal = input.framePaths || physicalFrames;

    /** 每帧的时间戳数组（毫秒），用于滑动窗口构建 */
    const frameTimeMs: number[] = Array.from({ length: totalFrameCount }, (_, i) => Math.round(i * estimatedInterval * 1000));

    /** 秒 → MM:SS.mm 格式 */
    const formatTimeStr = (sec: number) => {
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
    };

    /** 构建单帧的流式推送数据 */
    const buildPartialFrames = (): FrameDetail[] => {
      const details: FrameDetail[] = [];
      for (let fi = 0; fi < totalFrameCount; fi++) {
        if (!frameDescriptions[fi]) continue;
        const frameTimeSec = fi * estimatedInterval;
        const frameEndSec = frameTimeSec + estimatedInterval;
        const matchedAsr = asrLines.filter(line =>
          line.startTime <= frameEndSec && line.endTime >= frameTimeSec
        );
        const idx = physicalFrames.indexOf(allFrames[fi]);
        const url = (framePathsOriginal.length > 0 && idx >= 0) ? framePathsOriginal[idx] : allFrames[fi];
        details.push({
          url,
          description: frameDescriptions[fi],
          asrText: matchedAsr.map(l => l.text).join(' '),
          asrTime: matchedAsr.length > 0
            ? `${matchedAsr[0].startTime.toFixed(1)}s-${matchedAsr[matchedAsr.length - 1].endTime.toFixed(1)}s`
            : '',
          timeMs: Math.round(frameTimeSec * 1000),
          timeStr: formatTimeStr(frameTimeSec),
          editing: false,
          confirmed: true,
          emotion: frameJsonItems[fi]?.emotionTone || '',
        });
      }
      return details;
    };

    /** 执行单帧 VLM 分析（多帧滑动窗口模式） */
    const processFrame = async (frameIdx: number): Promise<void> => {
      const framePath = allFrames[frameIdx];

      /** 获取该帧对应的 ASR 台词 */
      const frameTimeSec = frameIdx * estimatedInterval;
      const frameEndSec = frameTimeSec + estimatedInterval;
      const matchedAsr = asrLines.filter(line =>
        line.startTime <= frameEndSec && line.endTime >= frameTimeSec
      );
      const asrText = matchedAsr.map(l => l.text).join(' ');

      /** 将 framesMode 映射为 Prompt 策略类型 */
      const promptStrategy: 'vlm_optimized' | 'uniform_fps' = input.framesMode === 'fps' ? 'uniform_fps' : 'vlm_optimized';

      /** 构建多帧滑动窗口 */
      const frameWindow = buildFrameWindow(allFrames, frameTimeMs, frameIdx, 2);

      /** 使用 PromptBuilder 构造提示词（多帧模式传入窗口信息） */
      const { systemPrompt, userPrompt } = PromptBuilder.buildVisionExtractPrompt(
        asrText, '', promptStrategy,
        frameWindow.length > 1 ? frameWindow : undefined,
      );

      /** 构建 user content：多帧模式下包含所有窗口帧图片，单帧降级仅目标帧 */
      const userContent: any[] = [
        { type: 'text', text: `${userPrompt}\n\n这是视频第${frameIdx + 1}帧（时间约${formatTimeStr(frameTimeSec)}）。请精确描述这一帧的画面内容，返回一个JSON对象。` },
      ];

      if (frameWindow.length > 1) {
        // 多帧模式：将所有窗口帧编码为 Base64 按序追加
        for (const item of frameWindow) {
          userContent.push({
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${getBase64(item.filePath)}` },
          });
        }
      } else {
        // 单帧降级模式：保持原有行为
        userContent.push({
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${getBase64(framePath)}` },
        });
      }

      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ];

      try {
        const rawResult = await adapter.chat(messages, model, 0.2);
        let resultText = '';
        if (rawResult && typeof rawResult === 'object') {
          if (rawResult.success === false) {
            throw new Error(`VLM 调用失败: ${rawResult.error || '未知错误'}`);
          }
          resultText = rawResult.text || '';
        } else if (typeof rawResult === 'string') {
          resultText = rawResult;
        }

        /** 解析 VLM 返回的 JSON 数据 */
        let parsedItem: any = null;
        try {
          const cleaned = resultText
            .replace(/```json\s*/gi, '')
            .replace(/```\s*/g, '')
            .trim();
          const parsed = JSON.parse(cleaned);
          // 可能是数组（VLM有时返回单元素数组），也可能是对象
          if (Array.isArray(parsed) && parsed.length > 0) {
            parsedItem = parsed[0];
          } else if (typeof parsed === 'object' && !Array.isArray(parsed)) {
            parsedItem = parsed;
          }
        } catch {
          // JSON 解析失败，降级到纯文本
        }

        if (parsedItem) {
          frameJsonItems[frameIdx] = parsedItem;
          // 合并五维叙事描述
          const parts = [
            parsedItem.narrativeAction || '',
            parsedItem.emotionalState ? `情绪:${parsedItem.emotionalState}` : '',
            parsedItem.visualAtmosphere ? `光影:${parsedItem.visualAtmosphere}` : '',
            parsedItem.spatialRelation ? `空间:${parsedItem.spatialRelation}` : '',
          ].filter(Boolean);
          frameDescriptions[frameIdx] = parts.join(' ');
        } else {
          // 纯文本降级
          frameDescriptions[frameIdx] = resultText.trim();
        }

        AppLogger.info(LOG_TAGS.AI_AGENT, `[画面描述] 帧 ${frameIdx + 1}/${totalFrameCount} 完成，JSON: ${parsedItem ? '成功' : '降级纯文本'}`);
      } catch (err: any) {
        AppLogger.error(LOG_TAGS.AI_AGENT, `[画面描述] 帧 ${frameIdx + 1} 异常: ${err.message}`);
        frameDescriptions[frameIdx] = '';
      }

      completedFrames++;
      const progressPct = 30 + Math.floor((completedFrames / totalFrameCount) * 65);
      onProgress(progressPct, `画面分析 ${completedFrames}/${totalFrameCount} 帧...`);

      // 💥 流式推送：每完成5帧或最后一批，推送已有描述到前端
      if (completedFrames % 5 === 0 || completedFrames === totalFrameCount) {
        onProgress(progressPct, `画面分析 ${completedFrames}/${totalFrameCount} 帧`, {
          partialFrames: buildPartialFrames(),
          completedCount: completedFrames,
          totalCount: totalFrameCount,
        });
      }
    };

    /** 并发调度：同时运行 CONCURRENT_VLM 路帧分析 */
    const frameQueue: number[] = Array.from({ length: totalFrameCount }, (_, i) => i);
    const running: Promise<void>[] = [];
    while (frameQueue.length > 0 || running.length > 0) {
      while (frameQueue.length > 0 && running.length < CONCURRENT_VLM) {
        const frameIdx = frameQueue.shift()!;
        const promise = processFrame(frameIdx).then(() => {
          const idx = running.indexOf(promise);
          if (idx >= 0) running.splice(idx, 1);
        });
        running.push(promise);
      }
      if (running.length > 0) {
        await Promise.race(running);
      }
    }

    /** 释放 LRU 缓存 */
    base64Cache.clear();

    const validCount = frameDescriptions.filter(d => d.trim()).length;
    AppLogger.info(LOG_TAGS.AI_AGENT, `[画面描述] 全部完成，总帧数: ${totalFrameCount}，有效描述: ${validCount}，覆盖率: ${((validCount / totalFrameCount) * 100).toFixed(1)}%`);

    /** 构建每帧完整信息 */
    const frameDetails: FrameDetail[] = allFrames.map((fp: string, i: number) => {
      const frameTimeSec = i * estimatedInterval;
      const frameEndSec = frameTimeSec + estimatedInterval;
      const matchedAsr = asrLines.filter(line =>
        line.startTime <= frameEndSec && line.endTime >= frameTimeSec
      );
      const idx = physicalFrames.indexOf(fp);
      const url = (framePathsOriginal.length > 0 && idx >= 0) ? framePathsOriginal[idx] : fp;
      const jsonItem = frameJsonItems[i];

      return {
        url,
        description: frameDescriptions[i] || '',
        asrText: matchedAsr.map(l => l.text).join(' '),
        asrTime: matchedAsr.length > 0
          ? `${matchedAsr[0].startTime.toFixed(1)}s-${matchedAsr[matchedAsr.length - 1].endTime.toFixed(1)}s`
          : '',
        timeMs: Math.round(frameTimeSec * 1000),
        timeStr: formatTimeStr(frameTimeSec),
        editing: false,
        confirmed: !!(frameDescriptions[i] && frameDescriptions[i].trim()),
        emotion: jsonItem?.emotionTone || '',
      };
    });

    onProgress(95, '画面感知完成，正在同步系统总线...');

    return {
      framesCount: totalFrameCount,
      sceneDescriptions: frameDescriptions.join('\n'),
      framePaths: frameDetails.map(f => f.url),
      frames: frameDetails,
    };
  }
}
