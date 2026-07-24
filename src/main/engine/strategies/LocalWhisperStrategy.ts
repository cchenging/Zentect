import { ITextExtractor, TextExtractResult } from './IExtractor';
import { AIDaemon } from '../../core/AIDaemon';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';
import { AppError, ErrorCode } from '@modules/infra/error/AppError';
import { detectFromASRJson } from '../media/MediaLanguageDetector';
import { PathManager } from '../../utils/pathManager';
import { ProcessManager } from '../../utils/processManager';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

const WHISPER_CLI_TIMEOUT_MS = 600000;

export class LocalWhisperStrategy implements ITextExtractor {

  public async transcribe(
    audioPath: string, outDir: string, mediaId: string,
    language: string = 'zh', engine: 'sensevoice' | 'whisper-v3' = 'sensevoice',
    signal?: AbortSignal,
    onProgress?: (pct: number, msg: string) => void
  ): Promise<TextExtractResult> {
    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[ASR Engine] 启动听写协议，目标语言: ${language}, 引擎: ${engine}`, { mediaId });

    if (!fs.existsSync(audioPath)) {
      throw new AppError(ErrorCode.FS_PATH_INVALID, `ASR 音频文件不存在: ${audioPath}`);
    }
    const audioStat = fs.statSync(audioPath);
    if (audioStat.size === 0) {
      throw new AppError(ErrorCode.FS_PATH_INVALID, `ASR 音频文件为空 (0 字节): ${audioPath}`);
    }
    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[ASR Engine] 音频文件大小: ${(audioStat.size / 1024).toFixed(1)} KB`);

    await fs.promises.mkdir(outDir, { recursive: true });
    const whisperOutPath = path.join(outDir, `transcript_${mediaId}.json`);

    if (engine === 'whisper-v3') {
      AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[ASR Engine] 用户指定 whisper-v3，跳过 SenseVoice`);
      return await this.transcribeViaLocalWhisper(audioPath, whisperOutPath, language, signal);
    }

    try {
      const daemon = AIDaemon.getInstance();
      if (daemon.isOnline()) {
        AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[ASR Engine] Python Daemon 在线，使用 SenseVoice 推理`);
        return await this.transcribeViaDaemon(daemon, audioPath, whisperOutPath, language, signal, onProgress);
      }
    } catch (daemonErr: any) {
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[ASR Engine] Python Daemon 调用失败，准备降级`, { error: daemonErr.message });
    }

    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[ASR Engine] 降级到本地 whisper-cli.exe 推理`);
    return await this.transcribeViaLocalWhisper(audioPath, whisperOutPath, language, signal);
  }

  private async transcribeViaDaemon(daemon: AIDaemon, audioPath: string, whisperOutPath: string, language: string, signal?: AbortSignal, onProgress?: (pct: number, msg: string) => void): Promise<TextExtractResult> {
    const audioSizeBytes = fs.statSync(audioPath).size;
    const estimatedDurationSec = (audioSizeBytes / (16000 * 2)) || 120;
    // ASR 超时放宽到 2 小时（长视频推理耗时）
    const timeoutMs = Math.max(120000, Math.min(7200000, Math.round(estimatedDurationSec * 1000)));

    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[ASR Engine] SenseVoice 超时设置: ${Math.round(timeoutMs / 1000)}s (音频估算 ${Math.round(estimatedDurationSec)}s)`);

    // 生成 task_id：Python 端按 task_id 隔离并发 ASR 任务的进度状态
    const taskId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const langCode = language === 'zh-CN' ? 'zh' : (language === 'en-US' ? 'en' : 'auto');

    // fire-and-forget POST：触发 Python ASR 任务，立即返回 task_id
    // 结果通过 SSE 流回传（progress.result），彻底规避 HttpClient 超时问题
    const { HttpClient } = await import('../../core/HttpClient');
    const { PythonProgressSubscriber } = await import('../media/PythonProgressSubscriber');
    const pythonPort = daemon.getPort();
    const transcribeUrl = `http://127.0.0.1:${pythonPort}/api/transcribe`;

    HttpClient.post(transcribeUrl, {
      audio_path: audioPath,
      output_json_path: whisperOutPath,
      language: langCode,
      task_id: taskId,
    }, { signal }).catch((err) => {
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[ASR Engine] POST 触发转写失败 (task=${taskId}): ${err?.message || err}`);
    });

    // SSE 订阅：实时推送 pct/msg，任务结束时携带 result 返回
    const sseResult = await PythonProgressSubscriber.subscribe(
      taskId,
      (pct, msg) => { if (onProgress) onProgress(pct, msg); },
      timeoutMs,
      signal,
      '/api/transcribe/stream/'  // ASR 专用 SSE 路径
    );

    // 从 SSE 携带的 result 取 ASR 产物
    if (sseResult.result?.success) {
      return this.parseAndWriteResult(whisperOutPath, language);
    }

    // SSE 流异常结束（超时/取消/Python 内部错误）
    if (sseResult.error) {
      throw new AppError(ErrorCode.AI_PROCESS_FAILED, `ASR SSE 订阅失败: ${sseResult.error}`);
    }
    throw new AppError(ErrorCode.AI_PROCESS_FAILED, 'ASR 微服务处理失败');
  }

  private async transcribeViaLocalWhisper(audioPath: string, whisperOutPath: string, language: string, signal?: AbortSignal): Promise<TextExtractResult> {
    const whisperDir = PathManager.getModelPath('whisper', '');
    const whisperExe = path.join(whisperDir, 'whisper-cli.exe');
    const modelPath = PathManager.getModelPath('whisper', 'ggml-base.bin');

    if (!fs.existsSync(whisperExe)) {
      throw new AppError(ErrorCode.AI_SERVICE_OFFLINE, `whisper-cli.exe 不存在: ${whisperExe}`);
    }
    if (!fs.existsSync(modelPath)) {
      throw new AppError(ErrorCode.AI_SERVICE_OFFLINE, `Whisper 模型不存在: ${modelPath}`);
    }

    const outputSrtPath = whisperOutPath.replace('.json', '.srt');
    const langCode = language === 'zh-CN' ? 'zh' : (language === 'en-US' ? 'en' : 'auto');

    const args = [
      '-m', modelPath,
      '-f', audioPath,
      '-l', langCode,
      '--output-srt',
      '--output-file', whisperOutPath.replace('.json', ''),
    ];

    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[ASR Local] whisper-cli 启动`, { exe: whisperExe, model: modelPath, lang: langCode });

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(whisperExe, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      ProcessManager.register(proc, 'asr-whisper-local');

      // Fix 10: 用户取消管线时强杀 whisper-cli 子进程
      const onAbort = () => { if (proc.pid) ProcessManager.killTree(proc.pid); reject(new AppError(ErrorCode.AI_PROCESS_FAILED, 'TASK_ABORTED')); };
      signal?.addEventListener('abort', onAbort);
      const cleanupSignal = () => signal?.removeEventListener('abort', onAbort);

      const timer = setTimeout(() => {
        if (proc.pid) ProcessManager.killTree(proc.pid);
        cleanupSignal();
        reject(new AppError(ErrorCode.AI_PROCESS_FAILED, `whisper-cli 执行超时 (${WHISPER_CLI_TIMEOUT_MS / 1000}s)`));
      }, WHISPER_CLI_TIMEOUT_MS);

      let stderr = '';
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      proc.stdout.on('data', () => {});

      proc.on('close', (code: number) => {
        clearTimeout(timer);
        cleanupSignal();
        if (code !== 0) {
          AppLogger.error(LOG_TAGS.MEDIA_ENGINE, `[ASR Local] whisper-cli 异常退出 (code: ${code})`, { stderr: stderr.slice(-500) });
          reject(new Error(`whisper-cli 退出码: ${code}`));
        } else {
          resolve();
        }
      });
      proc.on('error', (err) => { clearTimeout(timer); cleanupSignal(); reject(err); });
    });

    const srtPath = fs.existsSync(outputSrtPath) ? outputSrtPath : whisperOutPath.replace('.json', '.srt');
    if (!fs.existsSync(srtPath)) {
      throw new AppError(ErrorCode.AI_PROCESS_FAILED, `whisper-cli 未生成 SRT 文件: ${srtPath}`);
    }

    const srtContent = fs.readFileSync(srtPath, 'utf-8');
    const transcription = this.parseSrt(srtContent);

    const finalJson = {
      language: language === 'auto' ? 'zh' : language,
      transcription
    };

    fs.writeFileSync(whisperOutPath, JSON.stringify(finalJson, null, 2), 'utf-8');
    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[ASR Local] whisper-cli 识别完成，${transcription.length} 段台词`);

    const langCheck = detectFromASRJson(finalJson);
    if (langCheck.status !== 'zh') {
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[ASR 语言检测] ${langCheck.message}`, { status: langCheck.status });
    }

    try { fs.unlinkSync(srtPath); } catch {}

    return { whisperJsonPath: whisperOutPath };
  }

  private parseSrt(srtContent: string): Array<{ timestamps: { from: string; to: string }; text: string; emotion: string }> {
    const result: Array<{ timestamps: { from: string; to: string }; text: string; emotion: string }> = [];
    const blocks = srtContent.trim().split(/\n\s*\n/);

    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length < 3) continue;

      const timeMatch = lines[1]?.match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
      if (!timeMatch) continue;

      const from = timeMatch[1].replace(',', ',');
      const to = timeMatch[2].replace(',', ',');
      const text = lines.slice(2).join(' ').trim();

      if (text) {
        const cleaned = text.replace(/<\|.*?\|>/g, '').replace(/</g, '＜').replace(/>/g, '＞').trim();
        if (cleaned) {
          result.push({ timestamps: { from, to }, text: cleaned, emotion: 'NEUTRAL' });
        }
      }
    }

    return result;
  }

  private static formatSrtTimeFromSeconds(sec: number): string {
    const clamped = Math.max(0, sec);
    const h = Math.floor(clamped / 3600);
    const m = Math.floor((clamped % 3600) / 60);
    const s = Math.floor(clamped % 60);
    const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  }

  private static cleanText(raw: any): string {
    if (typeof raw !== 'string' || !raw) return '';
    let text = raw.replace(/<\|.*?\|>/g, '');
    text = text.replace(/^[<|]+|[>|]+$/g, '');
    return text.replace(/</g, '＜').replace(/>/g, '＞').trim();
  }

  private parseAndWriteResult(whisperOutPath: string, language: string): TextExtractResult {
    const pythonOut = JSON.parse(fs.readFileSync(whisperOutPath, 'utf-8'));
    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[ASR] Python 输出探测 (前200字): ${JSON.stringify(pythonOut).substring(0, 200)}`);

    let rawData = Array.isArray(pythonOut) ? pythonOut[0] : pythonOut;
    if (rawData.data) rawData = rawData.data;

    // 🔧 修复字段名不匹配：Python 写 segments（{start, end, text, originalText}，start/end 为数字秒）
    // 旧版读 transcription → 永远 false → 走估算分支，丢弃 Python 精确时间戳
    const segs = rawData.segments;
    if (Array.isArray(segs) && segs.length > 0) {
      AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[ASR] 检测到 Python segments (${segs.length} 段)，使用真实时间戳`);
      const transcription = segs.map((t: any) => {
        // Python start/end 为数字秒，转 SRT 字符串（HH:MM:SS,mmm）
        const fromSec = typeof t.start === 'number' ? t.start : 0;
        const toSec = typeof t.end === 'number' ? t.end : (fromSec + 2);
        return {
          timestamps: {
            from: LocalWhisperStrategy.formatSrtTimeFromSeconds(fromSec),
            to: LocalWhisperStrategy.formatSrtTimeFromSeconds(toSec),
          },
          text: LocalWhisperStrategy.cleanText(t.text || ''),
          emotion: t.emotion || rawData.emotion || 'NEUTRAL',
        };
      });

      const finalJson = { language: rawData.language || language, transcription };
      fs.writeFileSync(whisperOutPath, JSON.stringify(finalJson, null, 2), 'utf-8');
      AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[ASR Success] 使用真实时间戳解析 ${transcription.length} 段台词`);
      this.runLanguageCheck(finalJson, whisperOutPath);
      return { whisperJsonPath: whisperOutPath };
    }

    // 兜底：旧版 transcription 结构兼容（whisper-cli 路径或未来格式变更）
    if (rawData.transcription && Array.isArray(rawData.transcription) && rawData.transcription.length > 0) {
      const hasRealTimestamps = rawData.transcription.some((t: any) =>
        t.timestamps && (typeof t.timestamps.from === 'number' || typeof t.timestamps.to === 'number')
      );

      if (hasRealTimestamps) {
        AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[ASR] 检测到 transcription 真实时间戳，直接使用`);
        const transcription = rawData.transcription.map((t: any) => {
          const fromSec = typeof t.timestamps?.from === 'number' ? t.timestamps.from
            : (typeof t.start === 'number' ? t.start : 0);
          const toSec = typeof t.timestamps?.to === 'number' ? t.timestamps.to
            : (typeof t.end === 'number' ? t.end : fromSec + 2);
          return {
            timestamps: {
              from: LocalWhisperStrategy.formatSrtTimeFromSeconds(fromSec),
              to: LocalWhisperStrategy.formatSrtTimeFromSeconds(toSec),
            },
            text: LocalWhisperStrategy.cleanText(t.text || ''),
            emotion: t.emotion || 'NEUTRAL',
          };
        });

        const finalJson = { language: rawData.language || language, transcription };
        fs.writeFileSync(whisperOutPath, JSON.stringify(finalJson, null, 2), 'utf-8');
        AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[ASR Success] 使用真实时间戳解析 ${transcription.length} 段台词`);
        this.runLanguageCheck(finalJson, whisperOutPath);
        return { whisperJsonPath: whisperOutPath };
      }
    }

    AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[ASR] Python 未返回 segments/transcription，降级为估算分句`);
    return this.parseAndWriteResultWithEstimatedTimestamps(rawData, whisperOutPath, language);
  }

  private parseAndWriteResultWithEstimatedTimestamps(rawData: any, whisperOutPath: string, language: string): TextExtractResult {
    const rawText = rawData.text || rawData.content || '';
    const cleanedFullText = LocalWhisperStrategy.cleanText(rawText);

    if (!cleanedFullText || cleanedFullText.length < 1) {
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[ASR 异常] 清洗后文本为空`);
    }

    const totalDuration = rawData.duration || rawData.audio_duration || 0;
    const finalTranscription: Array<{ timestamps: { from: string; to: string }; text: string; emotion: any }> = [];

    if (totalDuration > 0 && cleanedFullText.length > 0) {
      const sentences = cleanedFullText.split(/([。！？；.!?;\n]+)/).filter(Boolean);
      const charCount = sentences.filter(s => !/^[。！？；.!?;\n]+$/.test(s)).reduce((sum, s) => sum + s.length, 0);
      const secPerChar = charCount > 0 ? totalDuration / charCount : 0.25;
      let currentStart = 0;

      for (let i = 0; i < sentences.length; i++) {
        const isPunctuation = /^[。！？；.!?;\n]+$/.test(sentences[i]);
        if (isPunctuation && finalTranscription.length > 0) {
          finalTranscription[finalTranscription.length - 1].text += sentences[i];
          continue;
        }

        const text = sentences[i].trim();
        if (text) {
          const dur = Math.max(1, text.length * secPerChar);
          finalTranscription.push({
            timestamps: {
              from: LocalWhisperStrategy.formatSrtTimeFromSeconds(currentStart),
              to: LocalWhisperStrategy.formatSrtTimeFromSeconds(Math.min(currentStart + dur, totalDuration)),
            },
            text,
            emotion: rawData.emotion || 'NEUTRAL',
          });
          currentStart += dur;
        }
      }
    } else {
      const sentences = cleanedFullText.split(/([。！？；.!?;\n]+)/).filter(Boolean);
      let currentStart = 0;
      let accumulated = '';

      for (let i = 0; i < sentences.length; i++) {
        accumulated += sentences[i];
        if (/^[。！？；.!?;\n]+$/.test(sentences[i]) || i === sentences.length - 1) {
          const t = accumulated.trim();
          if (t) {
            const dur = Math.max(2, t.length / 4);
            finalTranscription.push({
              timestamps: {
                from: LocalWhisperStrategy.formatSrtTimeFromSeconds(currentStart),
                to: LocalWhisperStrategy.formatSrtTimeFromSeconds(currentStart + dur),
              },
              text: t,
              emotion: rawData.emotion || 'NEUTRAL',
            });
            currentStart += dur;
          }
          accumulated = '';
        }
      }
    }

    const finalJson = { language: rawData.language || language, transcription: finalTranscription };
    fs.writeFileSync(whisperOutPath, JSON.stringify(finalJson, null, 2), 'utf-8');
    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[ASR Success] 估算时间戳解析 ${finalTranscription.length} 段台词 (估算模式)`);
    this.runLanguageCheck(finalJson, whisperOutPath);
    return { whisperJsonPath: whisperOutPath };
  }

  private runLanguageCheck(finalJson: any, whisperOutPath: string): void {
    const langCheck = detectFromASRJson(finalJson);
    if (langCheck.status !== 'zh') {
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[ASR 语言检测] ${langCheck.message}`, { status: langCheck.status });
      finalJson['_languageCheck'] = { status: langCheck.status, message: langCheck.message };
      fs.writeFileSync(whisperOutPath, JSON.stringify(finalJson, null, 2), 'utf-8');
    }
  }
}
