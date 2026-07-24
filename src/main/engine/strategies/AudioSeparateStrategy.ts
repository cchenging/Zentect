// 📁 路径：src/main/engine/strategies/AudioSeparateStrategy.ts
// @deprecated — 音频分离已迁移到 src/modules/media/audio/
//   新代码请使用 AudioSeparationService.separate()。
//   本文件仅保留管线适配层（BaseNodeStrategy 包装），
//   核心逻辑委托给新模块的 Service。

import { BaseNodeStrategy, ExecutionContext } from './BaseNodeStrategy';
import { AppLogger } from '../../core/AppLogger';
import { AudioSeparationService } from '@modules/media/audio/backend/Service';
import type { AudioSeparateInput as NewAudioSeparateInput } from '@modules/media/audio/types';

/** @deprecated 使用 src/modules/media/audio/types.ts 中的 AudioSeparateInput */
export interface AudioSeparateInput {
  mediaPath?: string;
  mediaId: string;
  engine?: 'spleeter' | 'uvr5';
}

/** @deprecated 使用 src/modules/media/audio/types.ts 中的 AudioSeparateOutput */
export interface AudioSeparateOutput {
  vocalPath: string;
  bgmPath: string;
}

/**
 * 人声分离管线策略
 * @deprecated 核心逻辑已迁移到 AudioSeparationService。
 *   新代码应直接使用 AudioSeparationService.separate()。
 *   本类仅作为 BaseNodeStrategy 适配层保留，未来版本将移除。
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

    // 委托给新模块的 Service
    const result = await AudioSeparationService.separate(
      { videoPath: sourcePath, engine } as NewAudioSeparateInput,
      {
        outputDir: cacheDir,
        filePrefix: input.mediaId,
        onProgress: (p, msg) => onProgress(p, msg),
      }
    );

    AppLogger.info('AudioSeparateStrategy', `Finished. Vocals: ${result.vocalsPath}`);

    return {
      vocalPath: result.vocalsPath,
      bgmPath: result.bgmPath,
    };
  }

  protected async cleanup(): Promise<void> {
    AppLogger.info('AudioSeparateStrategy', 'Cleanup completed.');
  }
}
