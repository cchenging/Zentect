// 📁 路径: src/main/engine/strategies/LocalWhisperStrategy.ts
import { ITextExtractor, TextExtractResult } from './IExtractor';
import { AIDaemon } from '../../core/AIDaemon';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '../../../shared/utils/LogConstants';
import { AppError, ErrorCode } from '../../../shared/utils/AppError';
import { detectFromASRJson } from '../media/MediaLanguageDetector';
import * as path from 'path';
import * as fs from 'fs';

export class LocalWhisperStrategy implements ITextExtractor {
  
  /**
   * 💥 巴别塔升级：新增 language 参数支持跨语种重组
   */
  public async transcribe(audioPath: string, outDir: string, mediaId: string, language: string = 'zh'): Promise<TextExtractResult> {
    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[ASR Engine] 启动巴别塔听写协议，目标语言提示: ${language}`, { mediaId });
    
    try {
      const whisperOutPath = path.join(outDir, `transcript_${mediaId}.json`);

      // 💥 宪法修正：将 language 注入请求载荷，确保外文视频能被正确识别
      const response = await AIDaemon.getInstance().post('/api/transcribe', {
        audio_path: audioPath,
        output_json_path: whisperOutPath,
        language: language === 'zh-CN' ? 'zh' : (language === 'en-US' ? 'en' : 'auto')
      });

      if (response && response.success) {
        const pythonOut = JSON.parse(fs.readFileSync(whisperOutPath, 'utf-8'));

        AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[ASR 极限侦察] Python 母舰输出探测 (前200字): ${JSON.stringify(pythonOut).substring(0, 200)}`);

        // 💥 宪法防线：多层级数据结构兼容
        // SenseVoiceSmall 经常返回单元素数组 [{text:...}] 或 直接的对象
        let rawData = Array.isArray(pythonOut) ? pythonOut[0] : pythonOut;
        if (rawData.data) rawData = rawData.data; // 适配部分框架包装

        const formatSrtTime = (sec: number) => {
          const d = new Date(Math.max(0, sec) * 1000);
          return `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')},${String(d.getUTCMilliseconds()).padStart(3, '0')}`;
        };

        // 💥 极限清洗函数：彻底杜绝尖括号截断白屏
        const cleanText = (raw: any) => {
          if (typeof raw !== 'string' || !raw) return '';
          // 1. 刮除控制符
          let text = raw.replace(/<\|.*?\|>/g, '');
          // 2. 移除可能残留的开头/结尾控制符残骸
          text = text.replace(/^[<|]+|[>|]+$/g, '');
          // 3. 转义普通尖括号，保护 React 渲染层
          return text.replace(/</g, '＜').replace(/>/g, '＞').trim();
        };

        // 如果没有时间戳（SenseVoice 特性），启动 NLP 伪切分引擎
        const rawText = rawData.text || rawData.content || '';
        const cleanedFullText = cleanText(rawText);

        if (!cleanedFullText || cleanedFullText.length < 1) {
            AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[ASR 异常] 清洗后文本为空，请检查视频是否有声或 Python 解析逻辑`);
        }

        // 构造最终符合时间轴引擎的 DTO
        const finalTranscription: Array<{ timestamps: { from: string; to: string }; text: string; emotion: any }> = [];
        const sentences = cleanedFullText.split(/([。！？；.!?;\n]+)/).filter(Boolean);
        let currentStart = 0;
        let accumulated = "";

        for (let i = 0; i < sentences.length; i++) {
          accumulated += sentences[i];
          if (/^[。！？；.!?;\n]+$/.test(sentences[i]) || i === sentences.length - 1) {
             const t = accumulated.trim();
             if (t) {
                const dur = Math.max(2, t.length / 4); // 粗略推算时长
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
        AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[ASR Success] 成功解析并伪切分 ${finalTranscription.length} 段台词`);

        // 🔍 语言检测：检查是否为外语或无台词影片
        const langCheck = detectFromASRJson(finalJson);
        if (langCheck.status !== 'zh') {
          AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[ASR 语言检测] ${langCheck.message}`, { status: langCheck.status });
          // 将检测结果写入 JSON 供上层决策
          finalJson['_languageCheck'] = { status: langCheck.status, message: langCheck.message };
          fs.writeFileSync(whisperOutPath, JSON.stringify(finalJson, null, 2), 'utf-8');
        }

        return { whisperJsonPath: whisperOutPath };
      } else {
        throw new AppError(ErrorCode.AI_PROCESS_FAILED, 'ASR 微服务处理失败');
      }
    } catch (error: any) {
      AppLogger.error(LOG_TAGS.MEDIA_ENGINE, `[ASR Fatal] 听写链路崩溃:`, error);
      throw new AppError(ErrorCode.AI_SERVICE_OFFLINE, `算力引擎异常: ${error.message}`);
    }
  }
}
