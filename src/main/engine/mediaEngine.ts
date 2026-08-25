// 📁 路径: src/main/engine/mediaEngine.ts
import { join, basename } from 'path';
import fs from 'fs/promises';
import { PathManager } from '../utils/pathManager';
import { VideoProcessor } from './media/VideoProcessor';
import { mediaProcessingService } from './MediaProcessingService';
import { MediaRepository } from '../database/repositories/MediaRepository';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import { ProjectService } from '../services/ProjectService';
import { MediaItem, Shot, Role, PipelineExtractionResult } from '../../shared/types';
import { DICT, ENGINE_STATUS } from '../../modules/infra/i18n/dictionary';
// 🎬 OP/ED 片头片尾裁剪策略（P0 手动裁剪）
import { resolveForMedia, applyToShots } from './utils/MediaTrimPolicy';

export class MediaEngine {

  // ============================================================
  // 🧹 ASR 文本清洗归一化（解决 8/19 项目台词带 🎼😊 嗯 啊 哦 等噪声的问题）
  //   区分「originalText（显示给用户看 / 审计）」和「aiText（给匹配/LLM 用的干净文本）」
  // ============================================================
  /** 函数级中文注释：把 Whisper/Funasr 产出的 ASR 原始文本做"噪声剥离 + 冗余语气词清理"。
   * 核心原则：
   *   - 返回值 { original, cleaned, isPureNoise }
   *   - original：轻度清洗（仅去掉控制字符/不可见 emoji，保留用户能识别的语气词/嗯啊），用于 UI 展示的 originalText 字段，用户看不到"被偷偷改掉的原文"
   *   - cleaned：重度清洗（剥离音乐符号 🎼♪、emoji、重复嗯啊哦语气词），给 Step3 ScriptGen / Step5 Match / TTS 使用，避免产生垃圾关键词
   *   - isPureNoise：整句清洗后空了，意味着"这段就是纯语气词/音乐"，调用方可直接跳过不落库或标为环境音
   * @param raw ASR 引擎输出的 item.text（可能带时间前后缀/音乐标记/语气词重复/emoji）
   */
  public static cleanAsrText(raw: string): { original: string; cleaned: string; isPureNoise: boolean; chineseCharCount: number } {
    const source = typeof raw === 'string' ? raw : '';

    // ============= 第一步：original（轻度清洗 + 统一空白）=============
    // 去掉 C0/C1 控制字符（0x00-0x1F 和 0x7F-0x9F），但保留换行/回车/tab（后续转空格）
    let original = source.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
    // 统一所有空白字符为单个空格（避免渲染成多行或缩进不齐）
    original = original.replace(/\s+/g, ' ').trim();

    // ============= 第二步：cleaned（重度清洗）=============
    let cleaned = original;

    // 2.1 剥离所有 Emoji 与特殊音乐符号（🎼♪♫♩♬♭♯😊😅😄🤔👍）
    //   - 覆盖 Unicode 15.1 Emoji 主范围：U+1F300 ~ U+1FAFF + U+2600 ~ U+27BF
    //   - 额外单独处理常见 1-char 音乐符/符号
    cleaned = cleaned.replace(/[\u{1F300}-\u{1FAFF}]/gu, ' ');
    cleaned = cleaned.replace(/[\u{2600}-\u{27BF}]/gu, ' ');
    cleaned = cleaned.replace(/[\u{1F000}-\u{1F2FF}]/gu, ' ');
    // 单独音乐标记：♪ ♫ ♩ ♬ ♭ ♯ 🎵 🎶 🎼 🎹 🎷 🎺 🎸 🎻 🎤 🎧 （补充遗漏在 emoji 范围外的单字节符号）
    cleaned = cleaned.replace(/[♪♫♩♬♭♯🎵🎶🎼🎹🎷🎺🎸🎻🎤🎧]/g, ' ');
    // 非汉字非 ASCII 符号的特殊装饰字符（F0 私人区 / 私用区字符）— 必须带 u flag，否则 \u{E000} 会被拆成 2 个 BMP 字符导致 Range out of order 报错
    cleaned = cleaned.replace(/[\u{E000}-\u{F8FF}]/gu, ' ');

    // 2.2 剥离语气词的"重复出现 + 边界孤立"，但不影响正常词内组合（如"好啊/我的妈呀/哦哦不对"里的正常字保留）
    //   ⚠️ 注意："呵/嘿/哈/嘻"这类和叠字强绑定的字不在集合中（避免误伤"呵呵对呵呵/哈哈哈哈哈哈哈哈"成正常句）
    const FILLER_CHARS = new Set(['嗯', '啊', '哦', '唉', '哎', '哟', '呀', '呢', '吧', '嘛', '啦', '呃', '呗', '哇', '哼', '欸', '啧', '唔', '喂']);
    const FILLER_REGEXP_SOURCE = Array.from(FILLER_CHARS).join('');
    // a) 先把重复语气词（嗯嗯嗯嗯、啊啊啊）归一化为单字（保留单字以便后续判定是否独立噪声）
    cleaned = cleaned.replace(new RegExp(`([${FILLER_REGEXP_SOURCE}])\\1{1,}`, 'g'), '$1');
    // b) 再把"独立出现 + 被空格包围"的语气词去掉，但词内组合（好啊/对啊/我的啊）保留
    //    做法反复迭代三次，避免"A 嗯 B 嗯 C"里第二个嗯因为前面是空格（B 被删后出现新边界）没清掉
    const RE_START_FILLERS = new RegExp(`^(?:[${FILLER_REGEXP_SOURCE}])+\\s+`);
    const RE_END_FILLERS = new RegExp(`\\s+(?:[${FILLER_REGEXP_SOURCE}])+$`);
    const RE_MID_FILLERS = new RegExp(`\\s+(?:[${FILLER_REGEXP_SOURCE}])+\\s+`, 'g');
    for (let iter = 0; iter < 3; iter++) {
      const before = cleaned;
      cleaned = cleaned
        .replace(RE_START_FILLERS, '')
        .replace(RE_END_FILLERS, '')
        .replace(RE_MID_FILLERS, ' ');
      if (cleaned === before) break;
    }
    // c) 最后单独的单个孤立语气词（如果整句只剩"嗯"）→ 空

    // 2.3 归一化中文标点：多余的？？？、，，，，缩成单个
    cleaned = cleaned.replace(/([，。？！,.?!:：;；])\1{1,}/g, '$1');
    // 2.4 去掉句首句尾孤立标点（避免"，裂纹横亘在鼎青楼"）
    cleaned = cleaned.replace(/^[\s，。？！,.?!:：;；、]+/, '').replace(/[\s，。？！,.?!:：;；、]+$/, '');

    // 2.5 统一空白（清洗 emoji/语气词后留下多空格）
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    // ============= 第三步：isPureNoise 判断 =============
    // 统计清洗后文本里的汉字数（当前项目场景是中文电视剧，非中文内容一律视为噪声/幻觉）
    const chineseMatch = cleaned.match(/[\u4e00-\u9fa5]/g);
    const chineseCharCount = chineseMatch ? chineseMatch.length : 0;
    // isPureNoise 判定（当前项目 = 中文短剧/电视剧）：
    //   - 汉字 = 0 → 整段英文/数字/符号 → 纯噪声（ASR 幻觉或 BGM 噪声）
    //   - 汉字 = 1 → 单个字（嗯/啊/哦/哎）→ 纯语气词噪声
    //   - 汉字 ≥ 2 → 认为是有效台词（哪怕是语气词叠字"嗯啊哈哈"，留给下游 TTS/Step3 过滤）
    const isPureNoise = chineseCharCount <= 1;

    return { original, cleaned, isPureNoise, chineseCharCount };
  }

  static async extractMetadata(filePath: string) { return await VideoProcessor.extractMetadata(filePath); }

  static async importMedia(projectId: string, filePaths: string[]) {
    const repo = new MediaRepository();
    const projectService = new ProjectService();
    const results: MediaItem[] = [];

    for (const filePath of filePaths) {
      try {
        const mediaId = `media_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const fileName = filePath.split(/[\\/]/).pop() || 'unknown';
        const ext = fileName.split('.').pop()?.toLowerCase() || '';

        let type: MediaItem['type'] = DICT.MEDIA_TYPE.IMAGE as MediaItem['type'];
        if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) type = DICT.MEDIA_TYPE.VIDEO as MediaItem['type'];
        else if (['mp3', 'wav', 'aac', 'flac', 'm4a'].includes(ext)) type = DICT.MEDIA_TYPE.AUDIO as MediaItem['type'];

        let metadata: any = { formattedTime: '00:00:00', duration: 0, width: 0, height: 0, fps: 0 };
        let pureCoverName = ''; 

        if (type === 'video') {
          metadata = await VideoProcessor.extractMetadata(filePath);
          pureCoverName = await VideoProcessor.generateCover(filePath, PathManager.getProjectThumbnailsDir(projectId), mediaId);
        } else if (type === 'audio') {
          const durSec = await mediaProcessingService.getMediaDuration(filePath);
          const h = Math.floor(durSec / 3600); const m = Math.floor((durSec % 3600) / 60); const s = Math.floor(durSec % 60);
          metadata.duration = durSec;
          metadata.formattedTime = `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
        }

        const relativeCoverPath = pureCoverName ? `thumbnails/${pureCoverName}` : '';
        const mediaItem: MediaItem & { duration: number, width: number, height: number, fps: number } = {
          id: mediaId, projectId, type, name: fileName,
          filePath, coverPath: relativeCoverPath, 
          status: 'parsed',
          duration: metadata.duration || 0,
          width: metadata.width || 0, height: metadata.height || 0, fps: metadata.fps || 0
        };
        // 💥 通过 DAO 调用，拒绝引擎直接写 SQL
        // 🔧 修复 TS2345：repo.insertMedia 期望严格 union 类型 ('video'|'audio'|'frame'|'video_chunk')，
        // 此处 type 已通过 DICT.MEDIA_TYPE 显式收窄，使用类型断言对齐
        repo.insertMedia(mediaItem as any);

        // 💥 返回给前端前，组装前端需要的字段
        const frontendMediaItem: MediaItem = {
          id: mediaItem.id, projectId: mediaItem.projectId, name: mediaItem.name, type: mediaItem.type,
          filePath: mediaItem.filePath, coverPath: mediaItem.coverPath, duration: metadata.formattedTime, status: 'parsed'
        };
        results.push(projectService.hydratePaths({ mediaItems: [frontendMediaItem] }, projectId).mediaItems[0]);
      } catch (error) { AppLogger.error(LOG_TAGS.AI_ENGINE, '导入媒体失败', { filePath, error }); }
    }
    return results;
  }

  // =====================================================================
  // 💥 统一管理：物理级媒体联合斩杀引擎！绝对不留一丝痕迹
  // =====================================================================
  static async deleteMedia(projectId: string, mediaId: string) {
    const repo = new MediaRepository();
    // 💥 1. 通过 Repo 拿封面信息 (可选使用)
    const coverPath = repo.getCoverPath(projectId, mediaId);
    void coverPath;
    // 💥 2. 通过 Repo 抹除记录 (SQL 彻底下放)
    try {
        const deleteFilesWithId = async (dirPath: string, id: string) => {
            try {
                const files = await fs.readdir(dirPath);
                for (const file of files) {
                    if (file.includes(id)) {
                        try { await fs.unlink(join(dirPath, file)); } catch(e) {
                            AppLogger.debug(LOG_TAGS.MEDIA_ENGINE, `删除文件失败: ${join(dirPath, file)}`, e)
                        }
                    }
                }
            } catch (e) {
                AppLogger.debug(LOG_TAGS.MEDIA_ENGINE, `遍历目录失败: ${dirPath}`, e)
            }
        };

        await deleteFilesWithId(PathManager.getProjectThumbnailsDir(projectId), mediaId);
        await deleteFilesWithId((PathManager as any).getProjectAudioDir(projectId), mediaId);
        await deleteFilesWithId((PathManager as any).getProjectFacesDir(projectId), mediaId);
        await deleteFilesWithId((PathManager as any).getProjectWhisperDir(projectId), mediaId);
    } catch(e) {
        AppLogger.error(LOG_TAGS.MEDIA_ENGINE, `清理媒体文件失败: ${mediaId}`, e);
    }

    // 删除数据库记录（文件已清理完才删数据库，避免 crash 导致文件孤儿）
    try { repo.deleteMediaById(projectId, mediaId); } catch(e) {
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `数据库删除失败: ${mediaId}`, e)
    }
    
    return true;
  }

  static async runIndustrialPipeline(filePath: string, projectId: string, category: string, mediaId: string, inPoint?: number, outPoint?: number, onProgress?: (percent: number, text: string) => void): Promise<PipelineExtractionResult> {
    const mediaDir = PathManager.getProjectMediaDir(projectId);
    void category; void onProgress; void mediaDir;
    
    // 💥 修复隐患：为当前媒体建立专属隔离区，防止抽帧相互污染！
    const framesAbsDir = join(PathManager.getProjectExtractionsDir(projectId, 'frames'), mediaId);
    const facesAbsDir = join(PathManager.getProjectExtractionsDir(projectId, 'faces'), mediaId);
    try { await fs.mkdir(framesAbsDir, { recursive: true }); } catch (e) {
      AppLogger.debug(LOG_TAGS.MEDIA_ENGINE, `创建帧目录失败: ${framesAbsDir}`, e)
    }
    try { await fs.mkdir(facesAbsDir, { recursive: true }); } catch (e) {
      AppLogger.debug(LOG_TAGS.MEDIA_ENGINE, `创建人脸目录失败: ${facesAbsDir}`, e)
    }

    const audioAbsDir = PathManager.getProjectExtractionsDir(projectId, 'audio');
    const rawAudioAbsPath = join(audioAbsDir, `audio_${mediaId}_16k.wav`);

    // 💥 接入雷达：获取跨端武器和模型
    const aiDaemonScript = PathManager.getScriptPath('ai_daemon.py');

    try {
      const videoIoTask = VideoProcessor.extractFrames(filePath, framesAbsDir, mediaId, { inPoint, outPoint });
      const audioIoTask = Promise.resolve(true);

      const audioAITask = audioIoTask.then(async (hasAudio) => {
         try {
             await fs.access(rawAudioAbsPath);
         } catch (e) {
             return null;
         }
         if (!hasAudio) return null;
         let targetAudio = rawAudioAbsPath;
         void targetAudio;
         let vocalsPath: string | undefined = undefined;
         let bgmPath: string | undefined = undefined;
         try {
             await fs.access(aiDaemonScript);
          try {
              const separated = { vocals: rawAudioAbsPath, bgm: undefined };
                 if (separated && separated.vocals) { targetAudio = separated.vocals; vocalsPath = separated.vocals; bgmPath = separated.bgm; }
             } catch (e) { }
         } catch (e) {
             // aiDaemonScript 不存在，跳过
         }
         const whisperOutPrefix = join(PathManager.getProjectExtractionsDir(projectId, 'whisper'), `whisper_${mediaId}`);
          const whisperResult = { whisperJsonPath: null, vocalsPath, bgmPath };
          void whisperResult;
         return { whisperJsonPath: whisperOutPrefix + '.json', vocalsPath, bgmPath };
      });

      const visionAITask = Promise.all([videoIoTask, audioAITask]).then(async ([frames, audioResult]) => {
         if (!frames || (frames as any).length === 0) return { finalRoles: [], audioResult };
         let finalRoles: any[] = [];
         try {
             await fs.access(aiDaemonScript);
             try { finalRoles = []; } catch (e) { }
         } catch (e) {
             // aiDaemonScript 不存在，跳过
         }
         return { finalRoles, audioResult };
      });

      const { finalRoles, audioResult } = await visionAITask;
      const framesAbsPaths = await videoIoTask;
      const hasAudio = await audioIoTask;

      // 生成相对路径
      const roles = finalRoles.map(r => {
        const sysId = r.systemId || '';
        const parts = sysId.split('_');
        return { id: `${mediaId}_${sysId}`, systemId: sysId, name: `角色_${parts[1] || sysId || 'unknown'}`, avatar: `extractions/faces/${mediaId}/${r.avatarPath ? basename(r.avatarPath) : ''}`, mergedRoles: [] };
      });
      const whisperPrefix = join(PathManager.getProjectExtractionsDir(projectId, 'whisper'), `whisper_${mediaId}`);
      
      const dto = await MediaEngine.assemblePipelineData(whisperPrefix, framesAbsDir, projectId, mediaId, inPoint, roles);
      let shots = dto.shots;

      const projectService = new ProjectService();
      // 💥 严丝合缝的输出 DTO
      const rawResult: PipelineExtractionResult = { 
          type: 'extract_media', mediaId, roles, shots, 
          frames: (framesAbsPaths as any).map((f: string) => `extractions/frames/${mediaId}/${basename(f)}`), 
          audioPath: hasAudio ? `extractions/audio/audio_${mediaId}_16k.wav` : undefined, 
          vocalsPath: audioResult?.vocalsPath ? `extractions/audio/${basename(audioResult.vocalsPath)}` : undefined, 
          bgmPath: audioResult?.bgmPath ? `extractions/audio/${basename(audioResult.bgmPath)}` : undefined, 
          text: dto.rawText 
      };

      return projectService.hydratePaths(rawResult, projectId);
    } catch (error) { throw error; }
  }

  /** 函数级中文注释：组装 Step1 素材分析的结果 DTO（帧路径 + ASR 台词）。
   *   🎬 P0 OP/ED 裁剪接入点：组装完 shots 后调用 MediaTrimPolicy.applyToShots，
   *      将台词时间轴平移 (start -= trimStartSec) 并删除掉 OP/ED 区间内的无意义段，
   *      保证 Step3 生成的解说词第一句直接对到真实正剧时间 0s。
   * @param whisperPrefix Whisper JSON 前缀（不含 .json/.srt）
   * @param framesAbsDir 抽帧绝对路径目录
   * @param projectId 项目 ID（用于读 projects.extraction_config.mediaTrim）
   * @param mediaId 素材 ID（用于 perMedia 精确裁剪）
   * @param inPoint 用户手动入点（秒；OP/ED 裁剪在其之后二次裁剪）
   * @param roles 角色数组（原样返回）
   */
  public static async assemblePipelineData(whisperPrefix: string, framesAbsDir: string, projectId: string, mediaId: string, inPoint?: number, roles: Role[] = [] ): Promise<{ rawText: string, shots: Shot[], roles: Role[] }> {
    const result: { rawText: string, shots: Shot[], roles: Role[] } = { rawText: '', shots: [], roles: roles };
    const timeOffset = inPoint || 0;
    let availableFrames: { time: number, path: string }[] = [];
    
    try {
        const files = await fs.readdir(framesAbsDir);
        availableFrames = files.filter(f => f.startsWith('frame_')).sort().map(file => {
            const seqStr = file.replace('frame_', '').replace('.jpg', '');
            // 💥 修复：映射正确的专属隔离区路径
            return { time: parseInt(seqStr, 10), path: `extractions/frames/${mediaId}/${file}` };
        });
    } catch (e) {
        // 目录不存在，跳过
    }

    const whisperJsonPath = `${whisperPrefix}.json`;
    try {
        await fs.access(whisperJsonPath);
    } catch (e) {
        return result;
    }

    let whisperData = { transcription: [] };
    try { 
        const jsonContent = await fs.readFile(whisperJsonPath, 'utf8');
        whisperData = JSON.parse(jsonContent); 
    } catch(e) { 
        return result;
    }

    let lastEndTime = 0; let lastCleanedText = ''; let hallucinationCount = 0;

    whisperData.transcription.forEach((item: any, index: number) => {
      // 兼容两种 whisper 输出结构：
      //   - 新版: { timestamps: { from: "00:00", to: "00:09" } } (Python daemon 结构)
      //   - 老版: { start: "00:00", startMs: 0, end: "00:09", endMs: 9000 } (8/19 项目 DB 存储的 extracted_text 结构，带毫秒)
      const tsFromRaw = item.timestamps?.from ?? item.start;
      const tsToRaw = item.timestamps?.to ?? item.end;
      const tStart = this.timeStrToSeconds(tsFromRaw) + timeOffset;
      const tEnd = this.timeStrToSeconds(tsToRaw) + timeOffset;

      // 🧹 调用统一的 ASR 清洗器：区分 original（给用户看）/ cleaned（给匹配/TTS 用）/ isPureNoise（纯语气词噪声段）
      const cleaned = MediaEngine.cleanAsrText(item.text ?? item.originalText ?? '');
      const { original: textOriginal, cleaned: textCleaned, isPureNoise } = cleaned;

      // 💥 幻觉重复检测改用 cleaned 文本（避免"嗯🎼😊😊" vs "嗯😊🎼🎼"这种字符不同但实际同内容被放过）
      if (textCleaned === lastCleanedText && textCleaned !== '') {
          hallucinationCount++;
          if (hallucinationCount >= 2) return;
      } else hallucinationCount = 0;
      lastCleanedText = textCleaned;

      // rawText 用于审计/调试，直接写原文轻度清洗结果
      result.rawText += `[${tsFromRaw}] ${textOriginal}\n`;

      // 空镜头间隙（和上一段台词距离 ≥3s）→ 生成一个环境音占位镜头
      if (tStart - lastEndTime >= 3) {
         const gapFrames = availableFrames.filter(f => f.time >= lastEndTime && f.time < tStart).map(f => f.path);
         if (gapFrames.length > 0) {
            result.shots.push({ id: `shot_gap_${Date.now()}_${index}`, mediaId, start: lastEndTime, end: tStart, originalText: '', aiText: '', contextFrames: gapFrames, coverPath: gapFrames[0] || '', roleId: '', visionText: '', audioEmotion: ENGINE_STATUS.PURE_ENVIRONMENT_SOUND } as any);
         }
      }

      const matchStart = Math.max(0, tStart - 0.5);
      const matchEnd = tEnd + 0.5;
      const matchedFrames = availableFrames.filter(f => f.time >= matchStart && f.time <= matchEnd).map(f => f.path);

      // 🎯 噪声段（isPureNoise）处理：
      //   - originalText 仍写入原文（用户UI看到"嗯/🎼😊"不会懵）
      //   - aiText 设空字符串（下游 Step3/Step5/Step4 TTS 会自动跳过空文本段，避免产生垃圾关键词/垃圾音轨）
      //   - audioEmotion 标记为 PURE_ENVIRONMENT_SOUND（纯环境音）
      result.shots.push({
        id: `shot_text_${Date.now()}_${index}`,
        mediaId,
        start: tStart,
        end: tEnd,
        originalText: textOriginal,
        aiText: isPureNoise ? '' : textCleaned,
        contextFrames: matchedFrames,
        coverPath: matchedFrames.length > 0 ? matchedFrames[0] : (availableFrames[0]?.path || ''),
        roleId: '',
        visionText: '',
        audioEmotion: isPureNoise ? ENGINE_STATUS.PURE_ENVIRONMENT_SOUND : ''
      } as any);
      lastEndTime = tEnd;
    });

    // 纯视觉帧组装：当没有台词数据但有抽帧时，按时间间隔将帧组装为镜头
    if (result.shots.length === 0 && availableFrames.length > 0) {
      const intervalSec = 5; // 每5秒一个镜头
      let shotIndex = 0;
      for (let timeStart = 0; timeStart < availableFrames[availableFrames.length - 1].time + intervalSec; timeStart += intervalSec) {
        const timeEnd = timeStart + intervalSec;
        const matchedFrames = availableFrames.filter(f => f.time >= timeStart && f.time < timeEnd).map(f => f.path);
        if (matchedFrames.length > 0) {
          result.shots.push({
            id: `shot_visual_${Date.now()}_${shotIndex}`,
            mediaId,
            start: timeStart,
            end: timeEnd,
            originalText: '',
            aiText: '',
            contextFrames: matchedFrames,
            coverPath: matchedFrames[0],
            roleId: '',
            visionText: '',
            audioEmotion: ''
          } as any);
          shotIndex++;
        }
      }
    }

    // 🎬 P0 OP/ED 裁剪：从 projects.extraction_config 拿 mediaTrim，统一平移 + 过滤 + 截断 shots 时间轴
    // 🆕 P0-1: resolveForMedia 附带 srcDurationMs（media_assets.duration），ED 尾部过滤/截断同步生效；
    //          查不到时长时退化为仅 OP 平移（向后兼容）。
    try {
      const trim = resolveForMedia(projectId, mediaId);
      if (trim.trimStartMs || trim.trimEndMs) {
        const beforeCount = result.shots.length;
        result.shots = applyToShots(result.shots, { ...trim, expectSource: true });
        AppLogger.info(LOG_TAGS.MEDIA, `[MediaEngine] OP/ED 裁剪: 素材 ${mediaId.slice(-8)} shots=${beforeCount} → ${result.shots.length} (OP=${trim.trimStartMs}ms / ED=${trim.trimEndMs}ms)`);
      }
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.MEDIA, `[MediaEngine] OP/ED 裁剪失败(安全保留原时间轴不裁剪): ${e.message}`);
    }

    return result;
  }

  private static timeStrToSeconds(timeStr: string): number {
    if (!timeStr) return 0;
    const cleanStr = timeStr.replace(',', '.');
    const parts = cleanStr.split(':').reverse();
    let seconds = 0;
    if (parts[0]) seconds += parseFloat(parts[0]);
    if (parts[1]) seconds += parseInt(parts[1]) * 60;
    if (parts[2]) seconds += parseInt(parts[2]) * 3600;
    return seconds;
  }
}
