// 路径：src/main/engine/strategies/ClipSemanticStrategy.ts
// CLIP 语义提取策略：为镜头构建高维语义索引，迁移自旧版 ExtractionPipeline

import { BaseNodeStrategy, ExecutionContext } from './BaseNodeStrategy';
import { VisionProcessor } from '../media/VisionProcessor';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';

export class ClipSemanticStrategy extends BaseNodeStrategy {
  readonly nodeType = 'clip-semantic';
  readonly isRecoverable = true;

  protected async performTask(
    input: any,
    context: ExecutionContext,
    _cacheDir: string,
    onProgress: (p: number, s: string) => void
  ): Promise<any> {
    const mediaId = input.mediaId || context.projectId || 'unknown';

    // 从 context.bus 获取上游组装的镜头数据
    let shots: any[] = [];
    try {
      shots = context.bus.get('assembled-shots') || context.bus.get('step1-shots') || [];
    } catch {
      // bus 读取失败继续
    }

    if (shots.length === 0) {
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[ClipSemantic] 无镜头数据，跳过 CLIP 语义提取');
      const empty = { sceneDescriptions: '', segments: [] };
      context.bus.set('clip-semantic-result', empty);
      return empty;
    }

    onProgress(10, `正在提取 CLIP 语义索引 (${shots.length} 个镜头)...`);

    try {
      const result = await VisionProcessor.extractSemantics(mediaId, shots);
      context.bus.set('clip-semantic-result', result);

      onProgress(100, 'CLIP 语义提取完成');
      AppLogger.info(LOG_TAGS.MEDIA_ENGINE,
        `[ClipSemantic] 提取完成: ${shots.length} 个镜头`);

      return result;
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
        `[ClipSemantic] CLIP 语义提取失败，降级跳过: ${e.message}`);
      const fallback = { sceneDescriptions: '', segments: [] };
      context.bus.set('clip-semantic-result', fallback);
      return fallback;
    }
  }
}
