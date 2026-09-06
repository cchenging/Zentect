// 📁 路径：src/main/engine/media/AudioProcessor.ts
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { PythonClient } from '../PythonClient';
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
    _mediaId: string,
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
    signal?: AbortSignal,
    inPoint?: number,
    outPoint?: number
  ): Promise<boolean | string> {
    const ffmpegExe = PathManager.getBinPath('ffmpeg.exe');
    if (!fs.existsSync(ffmpegExe) || !fs.existsSync(inputPath)) {
      return false;
    }

    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    // 44.1kHz 立体声 PCM，匹配 Demucs/MDX-Net 模型期望
    // 🎬 P1-2 OP/ED 源头裁剪：inPoint/outPoint 为【源坐标】秒，-ss/-to 放 -i 后（output seek），
    //   只提取正剧段（body 窗口），分离/降采样全部在 body 段上进行，产物时间轴从 0 起（body 坐标）。
    const args: string[] = ['-y', '-i', inputPath];
    if (inPoint !== undefined) args.push('-ss', inPoint.toString());
    if (outPoint !== undefined) args.push('-to', outPoint.toString());
    args.push('-vn', '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', outputPath);

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
   * @param engine     指定引擎：'demucs' | 'mdx'
   * @param onProgress 实时进度回调（通过 SSE 流式推送，替代旧版 500ms 轮询）
   */
  public static async separateVocalsBgm(
    inputAudioPath: string,
    outputDir: string,
    signal?: AbortSignal,
    engine: 'demucs' | 'mdx' = 'mdx',
    onProgress?: (pct: number, msg: string) => void
  ): Promise<{ vocals: string; bgm: string | undefined; _isFallback?: boolean } | null> {
    if (!fs.existsSync(inputAudioPath)) return null;

    const outBaseDir = path.join(outputDir, 'separated');
    if (!fs.existsSync(outBaseDir)) fs.mkdirSync(outBaseDir, { recursive: true });

    if (signal?.aborted) return null;

    try {
      const sseResult = await PythonClient.getInstance().callAsync(
        '/api/separate',
        { audio_path: inputAudioPath, output_dir: outBaseDir, engine },
        (pct, msg) => { if (onProgress) onProgress(pct, msg); },
        { signal, timeoutMs: 600000 }
      );

      if (sseResult.result?.vocals) {
        return {
          vocals: sseResult.result.vocals,
          bgm: sseResult.result.bgm || undefined,
        };
      }
      if (sseResult.error) {
        AppLogger.warn('AudioProcessor', `SSE 订阅异常结束: ${sseResult.error}`);
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
   *   - engine（quality 模式可选）：'demucs' | 'mdx'，控制 Python 端使用的分离引擎
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
      engine?: 'demucs' | 'mdx';
      onProgress?: (pct: number, msg: string) => void;
      /** 🎬 P1-2 OP/ED 源头裁剪：源坐标秒，只分离/降采样正剧段（body 窗口） */
      trimStartSec?: number;
      trimEndSec?: number;
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
    // 🎬 P1-2：有裁剪时只提取正剧段（body 窗口），分离/降采样只在 body 段上进行
    onProgress?.(5, '正在提取音频...');
    const hqResult = await AudioProcessor.extractHQAudio(
      mediaPath, hqPath, signal,
      options?.trimStartSec, options?.trimEndSec
    );
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
      options?.engine || 'mdx',
      onProgress
    );

    if (separated && separated.vocals) {
      // 🔧 修复：ASR 用原始 44.1k 降采样到 16k，不用分离后 vocals
      // 原因：Demucs 分离会损失高频细节，导致 faster-whisper 把 "I'm" 误识别成 "Mom"
      // 分离产物 vocals.wav/bgm.wav 仍保留，供 BGM 提取、TTS 等其他用途使用
      onProgress?.(95, '正在准备 ASR 音频...');
      const ok = await AudioProcessor.downsampleTo16k(hqPath, asrPath, signal);
      const finalAsr = ok ? asrPath : hqPath;
      // 清理中间产物：44.1k 原始提取文件（降采样已完成，不再需要）
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

  /** 正则：匹配 ffmpeg silencedetect 输出的静音起止时刻（秒） */
  private static readonly SILENCE_START_REGEX = /silence_start:\s*([\d.]+)/g;
  private static readonly SILENCE_END_REGEX = /silence_end:\s*([\d.]+)/g;

  /**
   * 🎬 素材修剪：检测并裁掉 TTS 配音/原声段首尾的静音与气口（吸气口、句尾拖音、空白），
   * 返回修剪后的音频路径与有效时长。
   *
   * 目的：让步骤4 回填的 audioDurationMs 反映"真实有效发音时长"，而非含前导停顿的整段时长，
   * 从而让步骤5 不再为了"凑"虚高时长去把视频强制拉伸（setpts/atempo），从根上消除画面/配音一顿一顿。
   *
   * 实现：
   *  1. 用 ffmpeg silencedetect 解析首尾静音边界（noise=-40dB:d=0.15）；
   *  2. 仅当开头/结尾确实存在冗余静音时才修剪（评估时间与真实气口无关的中间停顿不受影响）；
   *  3. 首尾各保留 padMs 安全边距，避免把辅音起音/尾音一刀切掉；
   *  4. 修剪后无缝重编码回原容器（WAV→pcm_s16le，MP3→libmp3lame），保证下游渲染兼容。
   *
   * @param inputPath   源音频物理路径
   * @param outputPath  修剪产物输出路径（扩展名应与源一致，决定重编码格式）
   * @param options     可选：noiseDb 静音阈值（默认 -40）、padMs 安全边距（默认 80）
   * @returns 修剪后的有效音频路径；若无首尾静音则原样返回源路径（并给出原时长）
   */
  public static async trimAudioEdges(
    inputPath: string,
    outputPath: string,
    options?: { noiseDb?: number; padMs?: number }
  ): Promise<{ outputPath: string; durationSec: number; trimmed: boolean }> {
    const ffmpegExe = PathManager.getBinPath('ffmpeg.exe');
    const ffprobeExe = PathManager.getBinPath('ffprobe.exe');
    if (!ffmpegExe || !ffprobeExe || !fs.existsSync(inputPath)) {
      // 工具或源文件缺失视为不可修剪：保持源状态，交由上层决定是否报错
      const rawSec = await AudioProcessor._probeSec(inputPath, ffprobeExe);
      return { outputPath: inputPath, durationSec: rawSec, trimmed: false };
    }

    const noiseDb = options?.noiseDb ?? -40;
    const padSec = (options?.padMs ?? 80) / 1000;

    // 1. silencedetect 探测首尾静音
    const detectArgs = ['-y', '-i', inputPath, '-af', `silencedetect=noise=${noiseDb}dB:d=0.15`, '-f', 'null', '-'];
    const stderr = await AudioProcessor._runFfmpegCapture(ffmpegExe, detectArgs);
    const totalSec = await AudioProcessor._probeSec(inputPath, ffprobeExe);

    const silences: Array<{ start: number; end: number }> = [];
    const starts = [...stderr.matchAll(AudioProcessor.SILENCE_START_REGEX)].map((m) => parseFloat(m[1]));
    const ends = [...stderr.matchAll(AudioProcessor.SILENCE_END_REGEX)].map((m) => parseFloat(m[1]));
    const n = Math.min(starts.length, ends.length);
    for (let i = 0; i < n; i++) silences.push({ start: starts[i], end: ends[i] });

    // 仅处理"首段开头静音"与"末段结尾静音"
    let startSec = 0;
    let endSec = totalSec;
    if (silences.length > 0) {
      const first = silences[0];
      if (first.start <= 0.2) startSec = first.end;      // 开头存在冗余静音 → 从首个语音起点切入
      const last = silences[silences.length - 1];
      if (last.end >= totalSec - 0.2) endSec = last.start; // 结尾存在冗余静音 → 到末段语音终点截止
    }

    // 2. 加安全边距（避免切断辅音起音/尾音），并夹取到合法区间
    startSec = Math.max(0, startSec - padSec);
    endSec = Math.min(totalSec, endSec + padSec);

    // 3. 无需修剪（首尾本就是语音，或检测失效）：原样返回
    if (startSec <= 0.05 && endSec >= totalSec - 0.05) {
      return { outputPath: inputPath, durationSec: totalSec, trimmed: false };
    }
    if (startSec >= endSec) {
      return { outputPath: inputPath, durationSec: totalSec, trimmed: false };
    }

    // 4. 按有效边界重编码回原容器
    const args: string[] = ['-y', '-i', inputPath, '-ss', startSec.toFixed(3), '-to', endSec.toFixed(3)];
    AudioProcessor._pushTrimEncoder(args, outputPath);
    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const code = await AudioProcessor._runFfmpegExit(ffmpegExe, args);
    if (code !== 0 || !fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
      // 重编码裁剪失败 → 抛错暴露根因（错就错，不静默回退源文件掩盖 ffmpeg 异常）
      throw new Error(`TTS 音频修剪失败（ffmpeg 退出码 ${code}），源文件未覆盖: ${inputPath}`);
    }
    const trimmedSec = await AudioProcessor._probeSec(outputPath, ffprobeExe);
    return { outputPath, durationSec: trimmedSec, trimmed: true };
  }

  /** 按源扩展名选择修剪重编码的音频编码器（容量与下游渲染兼容） */
  private static _pushTrimEncoder(args: string[], outputPath: string): void {
    if (path.extname(outputPath).toLowerCase() === '.wav') {
      args.push('-vn', '-acodec', 'pcm_s16le'); // WAV 保留无损 PCM，避免二次有损
    } else {
      args.push('-vn', '-c:a', 'libmp3lame', '-q:a', '2'); // MP3 高品质有损（q2≈192k）
    }
    args.push(outputPath);
  }

  /** ffprobe 读取音频有效时长（秒），失败返回 0 */
  private static _probeSec(audioPath: string, ffprobeExe: string): Promise<number> {
    return new Promise((resolve) => {
      if (!audioPath || !fs.existsSync(audioPath)) { resolve(0); return; }
      const child = spawn(ffprobeExe, ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioPath], { windowsHide: true });
      let out = '';
      child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      child.on('close', () => {
        const sec = parseFloat(out.trim());
        resolve(Number.isFinite(sec) && sec > 0 ? sec : 0);
      });
      child.on('error', () => resolve(0));
    });
  }

  /** 运行 ffmpeg 并捕获 stderr 文本（用于 silencedetect 解析），返回 stderr 全文 */
  private static _runFfmpegCapture(ffmpegExe: string, args: string[]): Promise<string> {
    return new Promise((resolve) => {
      const child = spawn(ffmpegExe, args, { windowsHide: true });
      let err = '';
      child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      child.on('close', () => resolve(err));
      child.on('error', () => resolve(err));
      ProcessManager.register(child, 'FFmpeg-静音探测');
    });
  }

  /** 运行 ffmpeg 并返回退出码（用于重编码裁剪） */
  private static _runFfmpegExit(ffmpegExe: string, args: string[]): Promise<number> {
    return new Promise((resolve) => {
      const child = spawn(ffmpegExe, args, { windowsHide: true });
      child.on('close', (code) => resolve(code === null ? 1 : code));
      child.on('error', () => resolve(1));
      ProcessManager.register(child, 'FFmpeg-音轨修剪');
    });
  }

  /** 调用 Spleeter 分离人声和背景音 */
  public static async separateVocals(
    inputAudioPath: string,
    outputDir: string,
    _engine: 'spleeter' | 'uvr5' = 'spleeter',
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
