// 📁 src/main/engine/strategies/ASRStrategy.ts
import { BaseNodeStrategy, ExecutionContext } from './BaseNodeStrategy';
import { PipelineTask } from '../../../shared/types';
import { LocalWhisperStrategy } from './LocalWhisperStrategy';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '../../../modules/infra/logger/LogConstants';
import { AppError, ErrorCode } from '../../../modules/infra/error/AppError';
import * as path from 'path';
import * as fs from 'fs';

export class ASRStrategy extends BaseNodeStrategy {
  readonly nodeType = 'asr';
  /** ASR 失败时允许降级跳过，不阻塞后续管线 */
  readonly isRecoverable = true;

  private whisperStrategy = new LocalWhisperStrategy();

  protected async performTask(
    task: PipelineTask,
    context: ExecutionContext,
    cacheDir: string,
    onProgress: (p: number, s: string) => void
  ): Promise<any> {
    const sourceMediaId = task.dependsOn?.[0];
    const sourceData = sourceMediaId ? context.bus.get(sourceMediaId) : null;

    /** 优先从 audio-separate 节点的产物拿人声，如果没有则用源媒体 */
    /** BaseNodeStrategy 将 params 和 mergedInputs 合并为扁平对象，直接从顶层取值 */
    const targetAudioPath = sourceData?.vocalAudioPath || sourceData?.filePath || task.mediaPath;

    if (!targetAudioPath) {
      throw new AppError(ErrorCode.AI_PROCESS_FAILED, 'ASR 失败：未找到音频输入源，请检查连线。');
    }

    /** 检查音频文件是否存在 */
    if (!fs.existsSync(targetAudioPath)) {
      throw new AppError(ErrorCode.FS_PATH_INVALID, `ASR 音频文件不存在: ${targetAudioPath}`);
    }

    const mediaId = task.nodeId;
    const outDir = path.dirname(targetAudioPath);

    /** 从 params 中提取语言参数 */
    const language = (task.params as any)?.language || 'zh';

    AppLogger.info(LOG_TAGS.SCHEDULER, `[ASR] 启动真实语音识别，音频: ${targetAudioPath}`);

    onProgress(10, '正在启动语音识别引擎...');

    try {
      const result = await this.whisperStrategy.transcribe(targetAudioPath, outDir, mediaId, language);
      onProgress(100, 'success');
      return result;
    } catch (error: any) {
      AppLogger.error(LOG_TAGS.SCHEDULER, `[ASR] 转录失败: ${error.message}`, error);
      onProgress(0, 'error');
      throw error;
    }
  }
}
