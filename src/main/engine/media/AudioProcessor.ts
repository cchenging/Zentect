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

    const args: string[] = ['-y', '-i', inputPath];
    if (inPoint !== undefined) args.push('-ss', inPoint.toString());
    if (outPoint !== undefined) args.push('-to', outPoint.toString());
    args.push('-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', outputPath);

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

  /**
   * 从原始媒体提取 44.1kHz 立体声 WAV，专供人声分离引擎使用
   * Demucs/MDX-Net 等模型在 44.1kHz stereo 上训练，输入 16kHz mono 会丢失高频信息导致分离质量下降
   * @returns 成功返回输出路径，失败返回 false
   */
  public static async extractHQAudio(
    inputPath: string,
    outputPath: string,
    signal?: AbortSignal
  ): Promise<boolean | string> {
    const ffmpegExe = PathManager.getBinPath('ffmpeg.exe');
    if (!fs.existsSync(ffmpegExe) || !fs.existsSync(inputPath)) {
      return false;
    }

    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    // 44.1kHz 立体声 PCM，匹配 Demucs/MDX-Net 模型期望
    const args = ['-y', '-i', inputPath, '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', outputPath];

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
          if (!stderr.includes('does not contain any stream') && !stderr.includes('Output file #0 does not contain any stream')) {
            AppLogger.warn('AudioProcessor', `HQ audio extraction failed with code ${code}`);
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
      ProcessManager.register(child, 'FFmpeg-HQ音频提取');
    });
  }

  /**
   * 调用 Demucs/MDX-Net 分离人声和背景音，均失败时返回 null（由上层走 fallback）
   * @param engine 指定引擎：'demucs' | 'mdx' | 'auto'（auto=Python 端默认顺序 Demucs→MDX）
   * @param onProgress 实时进度回调（从 Python /api/separate/progress 轮询得到）
   */
  public static async separateVocalsBgm(
    inputAudioPath: string,
    outputDir: string,
    signal?: AbortSignal,
    engine: 'demucs' | 'mdx' | 'auto' = 'auto',
    onProgress?: (pct: number, msg: string) => void
  ): Promise<{ vocals: string; bgm: string | undefined; _isFallback?: boolean } | null> {
    if (!fs.existsSync(inputAudioPath)) return null;

    const outBaseDir = path.join(outputDir, 'separated');
    if (!fs.existsSync(outBaseDir)) fs.mkdirSync(outBaseDir, { recursive: true });

    // 先检查信号是否已中止，避免无用调用
    if (signal?.aborted) return null;

    try {
      const { AIDaemon } = await import('../../core/AIDaemon');
      const { HttpClient } = await import('../../core/HttpClient');
      const pythonPort = AIDaemon.getInstance().getPort();
      const progressUrl = `http://127.0.0.1:${pythonPort}/api/separate/progress`;
      const separateUrl = `http://127.0.0.1:${pythonPort}/api/separate`;

      // 发起分离请求（不 await，后台运行），携带 engine 参数
      const postPromise = HttpClient.post(separateUrl, {
        audioPath: inputAudioPath,
        outputDir: outBaseDir,
        engine,
      }, { signal });

      // 轮询进度，直到完成或超时
      const POLL_INTERVAL_MS = 500;
      const MAX_POLL_SECONDS = 600; // 10 分钟上限
      let elapsedMs = 0;
      let lastPct = -1;

      while (elapsedMs < MAX_POLL_SECONDS * 1000) {
        if (signal?.aborted) return null;

        try {
          const progress = await HttpClient.get(progressUrl);
          const pct = progress?.pct ?? 0;
          const msg = progress?.msg ?? '';

          if (pct !== lastPct && onProgress) {
            onProgress(pct, msg);
            lastPct = pct;
          }

          if (progress?.done) {
            if (progress?.error) {
              AppLogger.warn('AudioProcessor', `AI Daemon 分离内部失败: ${progress.error}`);
              break;
            }
            if (progress?.result?.vocals) {
              return {
                vocals: progress.result.vocals,
                bgm: progress.result.bgm || undefined,
                _isFallback: progress.result._isFallback,
              };
            }
            break;
          }
        } catch {
          // 轮询失败（如 Daemon 重启），静默继续
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        elapsedMs += POLL_INTERVAL_MS;
      }

      // 轮询超时或进度报错时，等待 POST 结果兜底
      try {
        const result = await postPromise;
        if (result?.vocals) {
          return {
            vocals: result.vocals,
            bgm: result.bgm || undefined,
            _isFallback: result._isFallback,
          };
        }
      } catch {
        // 已在下方统一 fallback
      }
    } catch (error) {
      AppLogger.error('AudioProcessor', 'AI Daemon 人声分离失败', { error });
    }

    return null;
  }

  /**
   * 将音频降采样为 16kHz 单声道 WAV，供 ASR 识别使用
   * @param inputPath  输入音频路径（任意采样率/声道）
   * @param outputPath 输出 16kHz mono WAV 路径
   * @param signal     可选中止信号
   * @returns 成功返回 true，失败返回 false
   */
  public static async downsampleTo16k(
    inputPath: string,
    outputPath: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    const ffmpegExe = PathManager.getBinPath('ffmpeg.exe');
    if (!fs.existsSync(ffmpegExe) || !fs.existsSync(inputPath)) return false;

    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const args = ['-y', '-i', inputPath, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', outputPath];

    return new Promise((resolve) => {
      const child = spawn(ffmpegExe, args, { windowsHide: true });
      if (signal) {
        const onAbort = () => { child.kill('SIGKILL'); resolve(false); };
        signal.addEventListener('abort', onAbort);
        child.on('close', () => signal.removeEventListener('abort', onAbort));
      }
      child.on('close', (code) => {
        resolve(code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0);
      });
      child.on('error', () => resolve(false));
      ProcessManager.register(child, 'FFmpeg-降采样16k');
    });
  }

  /**
   * 单流方案：一次提取 44.1kHz stereo → 分离 → 按用途分发
   *   - 分离成功：vocals 降采样到 16k mono 给 ASR，bgm 保留 44.1k stereo 给渲染
   *   - 分离失败：从 44.1k 降采样到 16k mono 给 ASR 作为 fallback
   *   - 无音轨：返回 hasAudio=false，由上层决定如何处理
   *   - skipSeparation=true（fast 模式）：只提 44.1k 并降采样到 16k，跳过分离引擎
   *   - engine（quality 模式可选）：'demucs' | 'mdx' | 'auto'，控制 Python 端使用的分离引擎
   *   - onProgress：透传分离引擎的实时进度回调（P0 修复：链路不再断裂）
   * 这样消除了双流提取的冗余，且分离引擎仍吃 44.1kHz stereo 保证质量
   * @returns asrAudioPath 供 ASR 的 16k mono；vocalsPath/bgmPath 分离产物（44.1k stereo）；isFallback 是否降级
   */
  public static async extractAndSeparate(
    mediaPath: string,
    outputDir: string,
    mediaId: string,
    signal?: AbortSignal,
    options?: {
      skipSeparation?: boolean;
      engine?: 'demucs' | 'mdx' | 'auto';
      onProgress?: (pct: number, msg: string) => void;
    }
  ): Promise<{
    asrAudioPath: string | undefined;
    vocalsPath: string | undefined;
    bgmPath: string | undefined;
    isFallback: boolean;
    hasAudio: boolean;
  }> {
    if (!fs.existsSync(mediaPath)) {
      return { asrAudioPath: undefined, vocalsPath: undefined, bgmPath: undefined, isFallback: false, hasAudio: false };
    }

    const hqPath = path.join(outputDir, `audio_${mediaId}_44k.wav`);       // 44.1k stereo 中间产物
    const asrPath = path.join(outputDir, `audio_${mediaId}_16k.wav`);     // 16k mono 供 ASR
    const onProgress = options?.onProgress;

    // 步骤1：提取 44.1kHz stereo（分离引擎输入，也是后续降采样的源头）
    onProgress?.(5, '正在提取音频...');
    const hqResult = await AudioProcessor.extractHQAudio(mediaPath, hqPath, signal);
    if (!hqResult) {
      AppLogger.warn('AudioProcessor', `无有效音轨或 HQ 提取失败: ${mediaPath}`);
      return { asrAudioPath: undefined, vocalsPath: undefined, bgmPath: undefined, isFallback: false, hasAudio: false };
    }

    // fast 模式：跳过分离，直接降采样到 16k 供 ASR
    if (options?.skipSeparation) {
      onProgress?.(50, '极速模式：跳过分离，正在降采样...');
      const ok = await AudioProcessor.downsampleTo16k(hqPath, asrPath, signal);
      const finalAsr = ok ? asrPath : hqPath;
      // 降采样成功后清理 44.1k 中间文件
      if (ok) fs.unlink(hqPath, () => {});
      onProgress?.(100, '音频处理完成');
      return {
        asrAudioPath: finalAsr,
        vocalsPath: undefined,
        bgmPath: undefined,
        isFallback: true,
        hasAudio: true,
      };
    }

    // 步骤2：人声分离（吃 44.1k stereo，保证质量），透传 engine 和 onProgress
    onProgress?.(10, '正在分离人声...');
    const separated = await AudioProcessor.separateVocalsBgm(
      hqPath, outputDir, signal,
      options?.engine || 'auto',
      onProgress
    );

    if (separated && separated.vocals) {
      // 分离成功：vocals 降采样到 16k mono 供 ASR，bgm 保留 44.1k 给渲染
      onProgress?.(95, '正在准备 ASR 音频...');
      const ok = await AudioProcessor.downsampleTo16k(separated.vocals, asrPath, signal);
      // 降采样失败时直接用原 vocals（44.1k）作为 fallback，ASR 内部也能转
      const finalAsr = ok ? asrPath : separated.vocals;
      // 清理中间产物：44.1k 原始提取文件（分离已完成，不再需要）
      fs.unlink(hqPath, () => {});
      onProgress?.(100, '人声分离完成');
      return {
        asrAudioPath: finalAsr,
        vocalsPath: separated.vocals,
        bgmPath: separated.bgm,
        isFallback: !!separated._isFallback,
        hasAudio: true,
      };
    }

    // 分离失败：从 44.1k 降采样到 16k mono 供 ASR（保留原始音轨内容）
    AppLogger.warn('AudioProcessor', '人声分离失败，降级使用原始音轨供 ASR');
    onProgress?.(95, '分离失败，正在降级处理...');
    const ok = await AudioProcessor.downsampleTo16k(hqPath, asrPath, signal);
    const finalAsr = ok ? asrPath : hqPath;  // 降采样失败时直接用 44.1k 作为最后兜底
    onProgress?.(100, '降级处理完成');
    return {
      asrAudioPath: finalAsr,
      vocalsPath: undefined,
      bgmPath: undefined,
      isFallback: true,
      hasAudio: true,
    };
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
