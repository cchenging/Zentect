// 📁 路径：src/main/engine/strategies/VisionExtractStrategy.ts
import fs from 'fs';
import path from 'path';
import { BaseNodeStrategy, ExecutionContext } from './BaseNodeStrategy';
import { VisionProcessor } from '../media/VisionProcessor';
import { LLMFactory } from '../adapters/LLMFactory';
import { AppLogger } from '../../core/AppLogger';

export interface VisionExtractInput { mediaId: string; mediaPath: string; modelName?: string; framesMode?: 'fps' | 'scene'; framesValue?: number; }
export interface VisionExtractOutput { framesCount: number; sceneDescriptions: string; framePaths?: string[]; }

/** VLM 并发批处理的最大并发数 */
const VLM_CONCURRENCY = 3;

export class VisionExtractStrategy extends BaseNodeStrategy<VisionExtractInput, VisionExtractOutput> {
  public readonly nodeType = 'vision-extract';

  protected async validate(input: VisionExtractInput): Promise<void> {
    if (!input.mediaPath || !fs.existsSync(input.mediaPath)) throw new Error('视觉提取失败：未找到原始媒体文件');
  }

  /**
   * 执行视觉提取任务：抽帧 → VLM 并发分析 → 返回场景描述
   */
  protected async performTask(
    input: VisionExtractInput, 
    _context: ExecutionContext, 
    cacheDir: string,
    onProgress: (p: number, s: string) => void
  ): Promise<VisionExtractOutput> {
    
    const framesDir = path.join(cacheDir, `${input.mediaId}_frames`);
    
    onProgress(5, '启动物理视神经，正在扫描视频画面...');
    const frames = await VisionProcessor.extractKeyframes(
      input.mediaPath, framesDir, input.framesMode || 'scene', input.framesValue || 0.3,
      (percent) => onProgress(5 + Math.floor(percent * 0.25), `画面解码中: ${percent}%`)
    );

    if (frames.length === 0) throw new Error('未能从视频中提取到任何有效画面');

    onProgress(30, `抽取完成，共 ${frames.length} 个关键帧，封装多模态张量...`);

    const { adapter, modelName: resolvedModel } = LLMFactory.createAdapter('visual');
    const model = input.modelName || resolvedModel || 'qwen-vl-max';

    /** 分批处理帧：每批最多 10 帧，避免 token 溢出 */
    const BATCH_SIZE = 10;
    const allBatches: { start: number; frames: string[] }[] = [];
    for (let batchStart = 0; batchStart < frames.length; batchStart += BATCH_SIZE) {
      allBatches.push({
        start: batchStart,
        frames: frames.slice(batchStart, batchStart + BATCH_SIZE),
      });
    }

    const totalBatches = allBatches.length;
    const allDescriptions: string[] = new Array(totalBatches);
    let completedBatches = 0;

    onProgress(35, `VLM 并发分析启动，${totalBatches} 批，${VLM_CONCURRENCY} 路并发...`);

    /** 并发 Worker 池：同时处理 VLM_CONCURRENCY 批 */
    let nextBatchIdx = 0;
    const processBatch = async (workerId: number): Promise<void> => {
      while (nextBatchIdx < totalBatches) {
        const batchIdx = nextBatchIdx++;
        const batch = allBatches[batchIdx];

        const imageContents = batch.frames.map(framePath => {
          const base64 = fs.readFileSync(framePath, 'base64');
          return { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } };
        });

        const messages = [
          { role: 'system', content: '你是一个专业的视频画面解析引擎。请严格按照时间顺序，详细描述这些连续画面中发生的动作、人物神态、环境和景别。每帧描述单独一行，以序号开头。' },
          { role: 'user', content: [{ type: 'text', text: `请解析以下视频关键帧（第${batch.start + 1}-${batch.start + batch.frames.length}帧），并生成场景描述：` }, ...imageContents] }
        ];

        const rawResult = await adapter.chat(messages, model, 0.2);
        const resultText = typeof rawResult === 'string' ? rawResult : rawResult.text || '';
        allDescriptions[batchIdx] = resultText;

        completedBatches++;
        onProgress(
          35 + Math.floor((completedBatches / totalBatches) * 55),
          `VLM 分析进度: ${completedBatches}/${totalBatches} 批 (Worker-${workerId})`
        );
      }
    };

    /** 启动 VLM_CONCURRENCY 个并发 Worker */
    const workerCount = Math.min(VLM_CONCURRENCY, totalBatches);
    await Promise.all(Array.from({ length: workerCount }, (_, i) => processBatch(i)));

    const sceneDescriptions = allDescriptions.join('\n');

    onProgress(95, '画面感知完成，正在同步系统总线...');
    AppLogger.info('VisionExtractStrategy', `Extracted vision data length: ${sceneDescriptions.length}, frames: ${frames.length}`);

    return { framesCount: frames.length, sceneDescriptions, framePaths: frames };
  }
}
