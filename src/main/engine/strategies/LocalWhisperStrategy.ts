// 📁 路径: src/main/engine/strategies/LocalWhisperStrategy.ts
import { ITextExtractor, TextExtractResult } from './IExtractor';
import { AIDaemon } from '../../core/AIDaemon';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '../../../modules/infra/logger/LogConstants';
import { AppError, ErrorCode } from '../../../modules/infra/error/AppError';
import { detectFromASRJson } from '../media/MediaLanguageDetector';
import { PathManager } from '../../utils/pathManager';
import { ProcessManager } from '../../utils/processManager';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

export class LocalWhisperStrategy {

  /**
   * 语音识别主入口：优先使用 Python AIDaemon（SenseVoice），
   * 不可用时自动降级到本地 whisper-cli.exe 推理
   */
  public async transcribe(audioPath: string, outDir: string, mediaId: string, language: string = 'zh'): Promise<TextExtractResult> {
    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[ASR Engine] 启动听写协议，目标语言: ${language}`, { mediaId });

    /** 检查音频文件是否存在 */
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

    /** 优先尝试 Python AIDaemon（SenseVoice ONNX） */
    try {
      const daemon = AIDaemon.getInstance();
      if (daemon.isOnline()) {
        AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[ASR Engine] Python Daemon 在线，使用 SenseVoice 推理`);
        return await this.transcribeViaDaemon(daemon, audioPath, whisperOutPath, language);
      }
    } catch (daemonErr: any) {
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[ASR Engine] Python Daemon 调用失败，准备降级`, { error: daemonErr.message });
    }

    /** 降级：使用本地 whisper-cli.exe 推理 */
    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[ASR Engine] 降级到本地 whisper-cli.exe 推理`);
    return await this.transcribeViaLocalWhisper(audioPath, whisperOutPath, language);
  }

  /**
   * 通过 Python AIDaemon（SenseVoice）执行语音识别
   * 支持长音频分片处理，避免超时降级
   */
  private async transcribeViaDaemon(daemon: AIDaemon, audioPath: string, whisperOutPath: string, language: string): Promise<TextExtractResult> {
    /** 根据音频时长动态计算超时：每分钟音频给 60 秒超时，最低 120 秒，最高 7200 秒 */
    const audioSizeBytes = fs.statSync(audioPath).size;
    const estimatedDurationSec = (audioSizeBytes / (16000 * 2)) || 120; // 16kHz 16bit 单声道估算
    const timeoutMs = Math.max(120000, Math.min(7200000, Math.round(estimatedDurationSec * 1000)));

    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[ASR Engine] SenseVoice 超时设置: ${Math.round(timeoutMs / 1000)}s (音频估算 ${Math.round(estimatedDurationSec)}s)`);

    const response = await daemon.post('/api/transcribe', {
      audio_path: audioPath,
      output_json_path: whisperOutPath,
      language: language === 'zh-CN' ? 'zh' : (language === 'en-US' ? 'en' : 'auto')
    }, {
      timeout: timeoutMs,
      retries: 2,
    });

    if (response && response.success) {
      return this.parseAndWriteResult(whisperOutPath, language);
    } else {
      throw new AppError(ErrorCode.AI_PROCESS_FAILED, 'ASR 微服务处理失败');
    }
  }

  /**
   * 使用本地 whisper-cli.exe 执行语音识别（无需 Python）
   */
  private async transcribeViaLocalWhisper(audioPath: string, whisperOutPath: string, language: string): Promise<TextExtractResult> {
    /** whisper-cli.exe 位于 resources/models/whisper/ 目录下 */
    const whisperDir = PathManager.getModelPath('whisper', '');
    const whisperExe = path.join(whisperDir, 'whisper-cli.exe');
    const modelPath = PathManager.getModelPath('whisper', 'ggml-base.bin');

    if (!fs.existsSync(whisperExe)) {
      throw new AppError(ErrorCode.AI_SERVICE_OFFLINE, `whisper-cli.exe 不存在: ${whisperExe}`);
    }
    if (!fs.existsSync(modelPath)) {
      throw new AppError(ErrorCode.AI_SERVICE_OFFLINE, `Whisper 模型不存在: ${modelPath}`);
    }

    /** whisper-cli 输出 SRT 格式到文件 */
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

    /** 执行 whisper-cli 推理 */
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(whisperExe, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      ProcessManager.register(proc, 'asr-whisper-local');

      let stderr = '';
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      proc.stdout.on('data', () => {}); // 消费 stdout 防止阻塞

      proc.on('close', (code: number) => {
        if (code !== 0) {
          AppLogger.error(LOG_TAGS.MEDIA_ENGINE, `[ASR Local] whisper-cli 异常退出 (code: ${code})`, { stderr: stderr.slice(-500) });
          reject(new Error(`whisper-cli 退出码: ${code}`));
        } else {
          resolve();
        }
      });
      proc.on('error', (err) => reject(err));
    });

    /** 解析 SRT 输出并转为项目内部 JSON 格式 */
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

    /** 语言检测 */
    const langCheck = detectFromASRJson(finalJson);
    if (langCheck.status !== 'zh') {
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[ASR 语言检测] ${langCheck.message}`, { status: langCheck.status });
    }

    /** 清理 SRT 临时文件 */
    try { fs.unlinkSync(srtPath); } catch {}

    return { whisperJsonPath: whisperOutPath };
  }

  /**
   * 解析 SRT 格式字幕为项目内部 transcription 格式
   */
  private parseSrt(srtContent: string): Array<{ timestamps: { from: string; to: string }; text: string; emotion: string }> {
    const result: Array<{ timestamps: { from: string; to: string }; text: string; emotion: string }> = [];
    const blocks = srtContent.trim().split(/\n\s*\n/);

    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length < 3) continue;

      /** SRT 时间行格式：00:00:01,234 --> 00:00:05,678 */
      const timeMatch = lines[1]?.match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
      if (!timeMatch) continue;

      const from = timeMatch[1].replace(',', ',');
      const to = timeMatch[2].replace(',', ',');
      const text = lines.slice(2).join(' ').trim();

      if (text) {
        /** 清洗尖括号控制符 */
        const cleaned = text.replace(/<\|.*?\|>/g, '').replace(/</g, '＜').replace(/>/g, '＞').trim();
        if (cleaned) {
          result.push({ timestamps: { from, to }, text: cleaned, emotion: 'NEUTRAL' });
        }
      }
    }

    return result;
  }

  /**
   * 解析 Python Daemon 返回的 JSON 并写入最终格式
   */
  private parseAndWriteResult(whisperOutPath: string, language: string): TextExtractResult {
    const pythonOut = JSON.parse(fs.readFileSync(whisperOutPath, 'utf-8'));
    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[ASR] Python 输出探测 (前200字): ${JSON.stringify(pythonOut).substring(0, 200)}`);

    let rawData = Array.isArray(pythonOut) ? pythonOut[0] : pythonOut;
    if (rawData.data) rawData = rawData.data;

    const formatSrtTime = (sec: number) => {
      const d = new Date(Math.max(0, sec) * 1000);
      return `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')},${String(d.getUTCMilliseconds()).padStart(3, '0')}`;
    };

    const cleanText = (raw: any) => {
      if (typeof raw !== 'string' || !raw) return '';
      let text = raw.replace(/<\|.*?\|>/g, '');
      text = text.replace(/^[<|]+|[>|]+$/g, '');
      return text.replace(/</g, '＜').replace(/>/g, '＞').trim();
    };

    const rawText = rawData.text || rawData.content || '';
    const cleanedFullText = cleanText(rawText);

    if (!cleanedFullText || cleanedFullText.length < 1) {
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[ASR 异常] 清洗后文本为空`);
    }

    const finalTranscription: Array<{ timestamps: { from: string; to: string }; text: string; emotion: any }> = [];
    const sentences = cleanedFullText.split(/([。！？；.!?;\n]+)/).filter(Boolean);
    let currentStart = 0;
    let accumulated = "";

    for (let i = 0; i < sentences.length; i++) {
      accumulated += sentences[i];
      if (/^[。！？；.!?;\n]+$/.test(sentences[i]) || i === sentences.length - 1) {
        const t = accumulated.trim();
        if (t) {
          const dur = Math.max(2, t.length / 4);
          finalTranscription.push({
            timestamps: { from: formatSrtTime(currentStart), to: formatSrtTime(currentStart + dur) },
            text: t,
            emotion: rawData.emotion || 'NEUTRAL'
          });
          currentStart += dur;
        }
        accumulated = "";
      }
    }

    const finalJson = {
      language: rawData.language || language,
      transcription: finalTranscription
    };

    fs.writeFileSync(whisperOutPath, JSON.stringify(finalJson, null, 2), 'utf-8');
    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[ASR Success] 成功解析 ${finalTranscription.length} 段台词`);

    const langCheck = detectFromASRJson(finalJson);
    if (langCheck.status !== 'zh') {
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[ASR 语言检测] ${langCheck.message}`, { status: langCheck.status });
      finalJson['_languageCheck'] = { status: langCheck.status, message: langCheck.message };
      fs.writeFileSync(whisperOutPath, JSON.stringify(finalJson, null, 2), 'utf-8');
    }

    return { whisperJsonPath: whisperOutPath };
  }
}
