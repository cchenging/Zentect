// 📁 路径：src/main/engine/media/AudioProcessor.ts
import path from 'path';
import fs from 'fs';
import { ProcessManager } from '../../utils/processManager';
import { AppLogger } from '../../core/AppLogger';

export class AudioProcessor {
  // FFmpeg 典型的日志输出正则
  private static FFMPEG_DURATION_REGEX = /Duration: (\d{2}:\d{2}:\d{2}\.\d{2})/;
  private static FFMPEG_TIME_REGEX = /time=(\d{2}:\d{2}:\d{2}\.\d{2})/;

  /**
   * 💥 动作 1：从任意视频提取纯音频 (16kHz, 单声道，最适合给 Whisper 识别)
   */
  public static async extractAudioForASR(
    inputPath: string, 
    outputPath: string, 
    onProgress?: (p: number, msg: string) => void
  ): Promise<string> {
    AppLogger.info('AudioProcessor', `Extracting audio for ASR from ${inputPath}`);

    // 如果输出目录不存在，自动创建
    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    // FFmpeg 指令：-vn 去视频, -acodec pcm_s16le 转换为 16bit WAV, -ar 16000 采样率, -ac 1 单声道
    const args = [
      '-y', // 覆盖输出文件
      '-i', inputPath,
      '-vn', 
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      outputPath
    ];

    await ProcessManager.spawnSafe({
      command: 'ffmpeg', // 注意：生产环境需替换为打包后的 ffmpeg-static 绝对路径
      args,
      onProgress,
      totalDurationRegex: this.FFMPEG_DURATION_REGEX,
      progressRegex: this.FFMPEG_TIME_REGEX
    });

    return outputPath;
  }

  /**
   * 💥 动作 2：人声与背景音分离 (调用 Spleeter 或 UVR5 的 CLI)
   */
  public static async separateVocals(
    inputAudioPath: string,
    outputDir: string,
    engine: 'spleeter' | 'uvr5' = 'spleeter',
    onProgress?: (p: number, msg: string) => void
  ): Promise<{ vocalPath: string, bgmPath: string }> {
    AppLogger.info('AudioProcessor', `Separating vocals using ${engine}`);
    
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    // 演示：这里以调用本地 Python 的 Spleeter 为例
    // 实际项目中，你需要确保 Python 环境就绪，或者打包为 exe
    const args = [
      '-m', 'spleeter', 'separate',
      '-i', inputAudioPath,
      '-p', 'spleeter:2stems',
      '-o', outputDir
    ];

    await ProcessManager.spawnSafe({
      command: 'python',
      args,
      onProgress: (p, msg) => {
        // Spleeter 输出不规律，我们做个模拟平滑进度或直接透传
        if (onProgress) onProgress(p > 0 ? p : 50, `AI 引擎分离中: ${msg}`);
      }
    });

    // Spleeter 默认会在 outputDir 建立以原文件名为名字的文件夹，内部包含 vocals.wav 和 accompaniment.wav
    const baseName = path.basename(inputAudioPath, path.extname(inputAudioPath));
    const vocalPath = path.join(outputDir, baseName, 'vocals.wav');
    const bgmPath = path.join(outputDir, baseName, 'accompaniment.wav');

    return { vocalPath, bgmPath };
  }
}
