import { BaseNodeStrategy, ExecutionContext } from './BaseNodeStrategy';
import { PipelineTask } from '../../../shared/types';
import { AIDaemon } from '../../core/AIDaemon';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '../../../modules/infra/logger/LogConstants';

export class SentimentAnalyzeStrategy extends BaseNodeStrategy {
  readonly nodeType = 'sentiment-analyze';

  protected async performTask(
    task: PipelineTask,
    _context: ExecutionContext,
    _cacheDir: string,
    onProgress: (p: number, s: string) => void
  ): Promise<any> {
    onProgress(30, '正在分析语音情感...');

    /** BaseNodeStrategy 将 params 和 mergedInputs 合并为扁平对象，直接从顶层取值 */
    const audioPath = task.audioPath || task.vocalPath;
    if (!audioPath) throw new Error('情感分析失败：未找到音频输入');

    try {
      const result = await AIDaemon.getInstance().post('/api/emotion', {
        audio_path: audioPath,
      });
      onProgress(100, '情感分析完成');
      return { emotion: result?.emotion || 'neutral', segments: result?.segments || [] };
    } catch (e: any) {
      AppLogger.error(LOG_TAGS.AI_AGENT, '情感分析服务调用失败', e);
      throw new Error('情感分析服务异常');
    }
  }
}
