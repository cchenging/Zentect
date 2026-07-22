// 📁 路径：src/main/engine/media/AudioProcessor.ts
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { PathManager } from '../../utils/pathManager';
import { ProcessManager } from '../../utils/processManager';
import { AppLogger } from '../../core/AppLogger';

export class AudioProcessor {
  private static FFMPEG_DURATION_REGEX = /Duration: (\d{2}:\d{2}:\d{2}\.\d{2})/;
  private static FFMPEG_TIME_REGEX = /time=(\d{2}:\d{2}:\d{2}\.\d{2})/;

  /** 从视频中提取音频轨道为 16kHz WAV，供 ASR 识别使用 */
  public static async separateAudio(
    inputPath: string,
    outputPath: string,
    mediaId: string,
    inPoint?: number,
    outPoint?: number,
    signal?: AbortSignal
  ): Promise<boolean | string> {
    const ffmpegExe = PathManager.getBinPath('ffmpeg.exe');
    if (!fs.existsSync(ffmpegExe)) {
      AppLogger.warn('AudioProcessor', 'FFmpeg not found, skipping audio extraction');
      return false;
    }

    if (!fs.existsSync(inputPath)) {
      AppLogger.warn('AudioProcessor', `Input file not found: ${inputPath}`);
      return false;
    }

    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const args = ['-y'];
    if (inPoint !== undefined) args.push('-ss', inPoint.toString());
    if (outPoint !== undefined) args.push('-to', outPoint.toString());
    args.push('-i', inputPath, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', outputPath);

    return new Promise((resolve) => {
      const child = spawn(ffmpegExe, args, { windowsHide: true });
      let stderr = '';

      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      if (signal) {
        const onAbort = () => { child.kill('SIGKILL'); resolve(false); };
        signal.addEventListener('abort', onAbort);
        child.on('close', () => signal.removeEventListener('abort', onAbort));
      }

      child.on('close', (code) => {
        if (code !== 0 && code !== null) {
          /** FFmpeg 返回非零且无音频流时，说明视频没有音频轨道 */
          if (stderr.includes('does not contain any stream') || stderr.includes('Output file #0 does not contain any stream')) {
            AppLogger.info('AudioProcessor', `No audio track in: ${inputPath}`);
          } else {
            AppLogger.warn('AudioProcessor', `FFmpeg audio extraction failed with code ${code}`);
          }
          resolve(false);
          return;
        }
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          resolve(outputPath);
        } else {
          resolve(false);
        }
      });

      child.on('error', () => resolve(false));
      ProcessManager.register(child, 'FFmpeg-音频提取');
    });
  }

  /** 调用 Demucs/Spleeter 分离人声和背景音 */
  public static async separateVocalsBgm(
    inputAudioPath: string,
    outputDir: string,
    signal?: AbortSignal
  ): Promise<{ vocals: string; bgm: string; _isFallback?: boolean } | null> {
    if (!fs.existsSync(inputAudioPath)) return null;

    const outBaseDir = path.join(outputDir, 'separated');
    if (!fs.existsSync(outBaseDir)) fs.mkdirSync(outBaseDir, { recursive: true });

    try {
      const { AIDaemon } = await import('../../core/AIDaemon');
      const { HttpClient } = await import('../../core/HttpClient');
      const pythonPort = AIDaemon.getInstance().getPort();
      // Fix 10: 先检查信号是否已中止，避免无用调用
      if (signal?.aborted) return null;
      const result = await HttpClient.post(`http://127.0.0.1:${pythonPort}/api/separate`, {
        audioPath: inputAudioPath,
        outputDir: outBaseDir,
      });
      if (result?.vocals && result?.bgm) return { vocals: result.vocals, bgm: result.bgm };
    } catch {
      AppLogger.info('AudioProcessor', 'AI Daemon 人声分离不可用，使用 FFmpeg 降级方案');
    }

    const vocalsPath = path.join(outBaseDir, 'vocals.wav');
    const ffmpegExe = PathManager.getBinPath('ffmpeg.exe');
    if (!fs.existsSync(ffmpegExe)) return null;

    // Fix 10: 先检查信号是否已中止
    if (signal?.aborted) return null;

    return new Promise((resolve) => {
      const args = ['-y', '-i', inputAudioPath, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', vocalsPath];
      const child = spawn(ffmpegExe, args, { windowsHide: true });

      // Fix 10: 用户取消时强杀降级 FFmpeg 进程
      if (signal) {
        const onAbort = () => { child.kill('SIGKILL'); resolve(null); };
        signal.addEventListener('abort', onAbort);
        child.on('close', () => signal.removeEventListener('abort', onAbort));
        child.on('error', () => signal.removeEventListener('abort', onAbort));
      }

      child.on('close', (code) => {
        if (code === 0 && fs.existsSync(vocalsPath)) {
          resolve({ vocals: vocalsPath, bgm: '', _isFallback: true });
        } else {
          resolve(null);
        }
      });
      child.on('error', () => resolve(null));
      ProcessManager.register(child, 'FFmpeg-降级音频');
    });
  }

  /** 从视频中提取纯音频（16kHz 单声道 WAV），供 ASR 识别 */
  public static async extractAudioForASR(
    inputPath: string,
    outputPath: string,
    onProgress?: (p: number, msg: string) => void
  ): Promise<string> {
    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const ffmpegExe = PathManager.getBinPath('ffmpeg.exe');
    const args = ['-y', '-i', inputPath, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', outputPath];

    await ProcessManager.spawnSafe({
      command: ffmpegExe,
      args,
      onProgress,
      totalDurationRegex: this.FFMPEG_DURATION_REGEX,
      progressRegex: this.FFMPEG_TIME_REGEX
    });

    return outputPath;
  }

  /** 调用 Spleeter 分离人声和背景音 */
  public static async separateVocals(
    inputAudioPath: string,
    outputDir: string,
    engine: 'spleeter' | 'uvr5' = 'spleeter',
    onProgress?: (p: number, msg: string) => void
  ): Promise<{ vocalPath: string; bgmPath: string }> {
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const args = ['-m', 'spleeter', 'separate', '-i', inputAudioPath, '-p', 'spleeter:2stems', '-o', outputDir];

    await ProcessManager.spawnSafe({
      command: 'python',
      args,
      onProgress: (p, msg) => {
        if (onProgress) onProgress(p > 0 ? p : 50, `AI 引擎分离中: ${msg}`);
      }
    });

    const baseName = path.basename(inputAudioPath, path.extname(inputAudioPath));
    return {
      vocalPath: path.join(outputDir, baseName, 'vocals.wav'),
      bgmPath: path.join(outputDir, baseName, 'accompaniment.wav'),
    };
  }
}
