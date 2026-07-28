import type { ITextExtractor, TextExtractResult } from './IExtractor';
import { AIDaemon } from '../../core/AIDaemon';
import { PythonClient } from '../PythonClient';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';
import { AppError, ErrorCode } from '@modules/infra/error/AppError';
import { detectFromASRJson } from '../media/MediaLanguageDetector';
import * as path from 'path';
import * as fs from 'fs';

/**
 * ASR 策略：统一通过 Python Daemon 调用本地 ASR 模型
 *
 * 引擎选择：
 * - 'sensevoice'（默认）：中日韩粤语言，基于 FunASR + fsmn-vad
 * - 'faster-whisper'：英文/欧洲语言，基于 CTranslate2，WER 约 5%，速度比 whisper.cpp 快 4-8 倍
 *
 * 注：原 whisper.cpp 路径已移除（ggml-base.bin 模型 WER 17-30%，识别率不达标）
 */
export class LocalWhisperStrategy implements ITextExtractor {

  public async transcribe(
    audioPath: string, outDir: string, mediaId: string,
    language: string = 'zh', engine: 'sensevoice' | 'faster-whisper' = 'sensevoice',
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

    // 统一走 Python Daemon：SenseVoice / faster-whisper 都通过 HTTP+SSE 调用
    const daemon = AIDaemon.getInstance();
    if (!daemon.isOnline()) {
      throw new AppError(ErrorCode.AI_SERVICE_OFFLINE, 'Python Daemon 离线，无法执行 ASR 推理');
    }

    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[ASR Engine] Python Daemon 在线，使用 ${engine} 推理`);
    return await this.transcribeViaDaemon(audioPath, whisperOutPath, language, engine, signal, onProgress);
  }

  /**
   * 通过 Python Daemon 调用 ASR（统一使用 PythonClient.callAsync）
   * SenseVoice 和 faster-whisper 共用此路径，通过 engine 参数区分
   */
  private async transcribeViaDaemon(
    audioPath: string, whisperOutPath: string,
    language: string, engine: string,
    signal?: AbortSignal, onProgress?: (pct: number, msg: string) => void
  ): Promise<TextExtractResult> {
    const audioSizeBytes = fs.statSync(audioPath).size;
    const estimatedDurationSec = (audioSizeBytes / (16000 * 2)) || 120;
    // ASR 超时放宽到 2 小时（长视频推理耗时）
    const timeoutMs = Math.max(120000, Math.min(7200000, Math.round(estimatedDurationSec * 1000)));

    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[ASR Engine] ${engine} 超时设置: ${Math.round(timeoutMs / 1000)}s (音频估算 ${Math.round(estimatedDurationSec)}s)`);

    // 语言代码映射：BCP-47 (zh-CN/en-US/id-ID) → Whisper 语言代码 (zh/en/id)
    const langCode = LocalWhisperStrategy.normalizeLangCode(language);

    // PythonClient.callAsync 内部处理 POST 触发 + SSE 订阅，消除竞态
    const sseResult = await PythonClient.getInstance().callAsync(
      '/api/transcribe',
      { audio_path: audioPath, output_json_path: whisperOutPath, language: langCode, engine },
      (pct, msg) => { if (onProgress) onProgress(pct, msg); },
      { signal, timeoutMs, streamPath: '/api/transcribe/stream/' }
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

  private static formatSrtTimeFromSeconds(sec: number): string {
    const clamped = Math.max(0, sec);
    const h = Math.floor(clamped / 3600);
    const m = Math.floor((clamped % 3600) / 60);
    const s = Math.floor(clamped % 60);
    const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  }

  /**
   * 语言代码归一化：将 BCP-47 格式（zh-CN/en-US/id-ID）映射为 Whisper 支持的语言代码
   * Whisper 支持的语言代码列表见: https://github.com/openai/whisper/blob/main/whisper/tokenizer.py
   *
   * 规则:
   *   1. 'auto' / '' / undefined → 'auto'（让 faster-whisper 自动检测）
   *   2. 已是 Whisper 2字母代码（en/zh/id/ms/th/vi/fr/de/es/...）→ 直接返回
   *   3. BCP-47 区域代码（zh-CN/en-US/id-ID）→ 取主语言标签
   *   4. 中文特殊变体：zh-CN/zh-TW/zh-HK → 'zh'，粤语 'yue' 保留
   *
   * 支持的 Whisper 语言（部分）：
   *   en zh ja ko yue id ms th vi fil ta hi bn ar ru fr de es it pt nl pl tr
   */
  private static normalizeLangCode(language: string): string {
    if (!language || language === 'auto') return 'auto';

    const lower = language.toLowerCase().trim();

    // 中文变体：zh-CN/zh-TW/zh-Hans/zh-Hant → zh；yue 保留（粤语 SenseVoice 支持）
    if (lower.startsWith('zh-') || lower === 'zh') return 'zh';
    if (lower === 'yue') return 'yue';

    // 已是 2 字母代码的直接返回（白名单：Whisper 支持的常见语言）
    const WHISPER_LANGS = new Set([
      'en', 'zh', 'ja', 'ko', 'yue',
      'id', 'ms', 'th', 'vi', 'fil', 'ta', 'hi', 'bn', 'ar', 'he', 'fa', 'ur',
      'ru', 'uk', 'kk', 'uz',
      'fr', 'de', 'es', 'it', 'pt', 'nl', 'pl', 'tr', 'sv', 'no', 'da', 'fi',
      'cs', 'sk', 'hu', 'ro', 'bg', 'hr', 'sr', 'sl', 'el', 'lt', 'lv', 'et',
      'ca', 'gl', 'eu', 'af', 'sw',
    ]);
    if (WHISPER_LANGS.has(lower)) return lower;

    // BCP-47 格式：取主语言标签（zh-CN → zh, id-ID → id, ms-MY → ms）
    if (lower.includes('-')) {
      const primary = lower.split('-')[0];
      if (WHISPER_LANGS.has(primary)) return primary;
    }

    // 未识别的语言代码：返回 'auto' 让 faster-whisper 自动检测
    AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
      `[ASR] 未识别的语言代码: ${language}，回退到 auto 自动检测`);
    return 'auto';
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
