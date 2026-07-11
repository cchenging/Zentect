import { BaseNodeStrategy, ExecutionContext } from './BaseNodeStrategy';
import { PipelineTask } from '../../../shared/types';
import { AIDaemon } from '../../core/AIDaemon';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '../../../modules/infra/logger/LogConstants';

export class FaceDetectStrategy extends BaseNodeStrategy {
  readonly nodeType = 'face-detect';

  protected async performTask(
    task: PipelineTask,
    _context: ExecutionContext,
    _cacheDir: string,
    onProgress: (p: number, s: string) => void
  ): Promise<any> {
    /** BaseNodeStrategy 将 params 和 mergedInputs 合并为扁平对象，直接从顶层取值 */
    const mediaPath = task.mediaPath;
    if (!mediaPath) throw new Error('人物识别失败：未找到媒体文件路径');

    onProgress(30, '正在扫描人脸特征...');

    try {
      const result = await AIDaemon.getInstance().post('/api/vision', { image_paths: [mediaPath] });
      onProgress(100, '人脸扫描完成');
      return { faces: result?.faces || [], faceCount: result?.faces?.length || 0 };
    } catch (e: any) {
      AppLogger.error(LOG_TAGS.AI_AGENT, '人脸识别接口调用失败', e);
      throw new Error('人脸识别服务异常');
    }
  }
}
