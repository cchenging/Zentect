import { BaseNodeStrategy, ExecutionContext } from './BaseNodeStrategy';
import { PipelineTask } from '../../../shared/types';
import { AIDaemon } from '../../core/AIDaemon';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '../../../shared/utils/LogConstants';

export class SemanticAnalyzeStrategy extends BaseNodeStrategy {
  readonly nodeType = 'semantic-analyze';

  protected async performTask(
    task: PipelineTask,
    _context: ExecutionContext,
    cacheDir: string,
    onProgress: (p: number, s: string) => void
  ): Promise<any> {
    const mediaPath = task.mergedInputs?.mediaPath;
    if (!mediaPath) throw new Error('语义分析失败：未找到媒体文件路径');

    onProgress(30, '正在提取视觉语义特征...');

    try {
      const result = await AIDaemon.getInstance().post('/api/extract_semantics', {
        media_path: mediaPath,
        frames_dir: cacheDir,
      });
      onProgress(100, '语义特征提取完成');
      return { sceneDescriptions: result?.descriptions || '', segments: result?.segments || [] };
    } catch (e: any) {
      AppLogger.error(LOG_TAGS.AI_AGENT, '语义分析服务调用失败', e);
      throw new Error('语义分析服务异常');
    }
  }
}
