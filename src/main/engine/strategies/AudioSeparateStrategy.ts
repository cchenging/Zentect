// 📁 路径：src/main/engine/strategies/AudioSeparateStrategy.ts
import { BaseNodeStrategy, ExecutionContext } from './BaseNodeStrategy';
import { AudioProcessor } from '../media/AudioProcessor';
import { AppLogger } from '../../core/AppLogger';

export interface AudioSeparateInput {
  mediaPath?: string; // 如果节点自带输入
  mediaId: string;
  engine?: 'spleeter' | 'uvr5';
}

export interface AudioSeparateOutput {
  vocalPath: string;
  bgmPath: string;
}

/**
 * 💥 真实物理节点：人声分离策略
 */
export class AudioSeparateStrategy extends BaseNodeStrategy<AudioSeparateInput, AudioSeparateOutput> {
  readonly nodeType = 'audio-separate';

  protected async validate(input: AudioSeparateInput): Promise<void> {
    if (!input.mediaPath) {
      throw new Error('未提供需要分离的媒体文件路径');
    }
  }

  protected async performTask(
    input: AudioSeparateInput,
    _context: ExecutionContext,
    cacheDir: string,
    onProgress: (p: number, s: string) => void
  ): Promise<AudioSeparateOutput> {
    const engine = input.engine || 'spleeter';
    const sourcePath = input.mediaPath!;

    const extractWavPath = input.mediaId + '_extracted.wav';
    const sepOutputDir = cacheDir;

    onProgress(5, '正在分离物理音轨...');
    await AudioProcessor.extractAudioForASR(sourcePath, extractWavPath, (percent, msg) => {
      const mappedProgress = 5 + Math.floor(percent * 0.35);
      onProgress(mappedProgress, `抽取音轨: ${msg}`);
    });

    onProgress(40, `正在启动 ${engine.toUpperCase()} 引擎进行频段分离...`);
    const { vocalPath, bgmPath } = await AudioProcessor.separateVocals(
      extractWavPath,
      sepOutputDir,
      engine,
      (percent, msg) => {
        const mappedProgress = 40 + Math.floor((percent > 0 ? percent : 50) * 0.55);
        onProgress(mappedProgress, msg);
      }
    );

    onProgress(100, '人声与伴奏分离完成！');
    AppLogger.info('AudioSeparateStrategy', `Finished. Vocals: ${vocalPath}`);

    return { vocalPath, bgmPath };
  }

  protected async cleanup(): Promise<void> {
    AppLogger.info('AudioSeparateStrategy', 'Cleanup completed.');
  }
}
