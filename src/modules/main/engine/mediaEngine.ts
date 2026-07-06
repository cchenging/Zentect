// 📁 路径: src/main/engine/mediaEngine.ts
import { join, basename } from 'path';
import fs from 'fs/promises';
import { PathManager } from '../utils/pathManager';
import { VideoProcessor } from './media/VideoProcessor';
import { AIEngine } from './AIEngine';
import { MediaRepository } from '../database/repositories/MediaRepository';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../infra/logger/LogConstants';
import { ProjectService } from '../services/ProjectService';
import { MediaItem, Shot, Role, PipelineExtractionResult } from '../../shared/types';
import { DICT, ENGINE_STATUS } from '../../infra/i18n/dictionary';

export class MediaEngine {

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
          const durSec = await AIEngine.getMediaDuration(filePath);
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
        repo.insertMedia(mediaItem);

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
    const whisperExe = PathManager.getBinPath(PathManager.getExeName('whisper-cli'));
    const whisperModel = PathManager.getModelPath('whisper', 'ggml-base.bin');
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
          try {
              await fs.access(whisperExe);
              await fs.access(whisperModel);
              const whisperResult = { whisperJsonPath: null, vocalsPath, bgmPath };
              void whisperResult;
             return { whisperJsonPath: whisperOutPrefix + '.json', vocalsPath, bgmPath };
         } catch (e) {
             return { whisperJsonPath: null, vocalsPath, bgmPath };
         }
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
      
      const dto = await MediaEngine.assemblePipelineData(whisperPrefix, framesAbsDir, mediaId, inPoint, roles);
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

  public static async assemblePipelineData(whisperPrefix: string, framesAbsDir: string, mediaId: string, inPoint?: number, roles: Role[] = [] ): Promise<{ rawText: string, shots: Shot[], roles: Role[] }> {
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

    let lastEndTime = 0; let lastText = ''; let hallucinationCount = 0;

    whisperData.transcription.forEach((item: any, index: number) => {
      const tStart = this.timeStrToSeconds(item.timestamps.from) + timeOffset;
      const tEnd = this.timeStrToSeconds(item.timestamps.to) + timeOffset;
      const text = item.text.trim();

      if (text === lastText && text !== '') {
          hallucinationCount++;
          if (hallucinationCount >= 2) return;
      } else hallucinationCount = 0;
      lastText = text;

      result.rawText += `[${item.timestamps.from}] ${text}\n`;

      if (tStart - lastEndTime >= 3) {
         const gapFrames = availableFrames.filter(f => f.time >= lastEndTime && f.time < tStart).map(f => f.path);
         if (gapFrames.length > 0) {
            result.shots.push({ id: `shot_gap_${Date.now()}_${index}`, mediaId, start: lastEndTime, end: tStart, originalText: '', aiText: '', contextFrames: gapFrames, coverPath: gapFrames[0] || '', roleId: '', visionText: '', audioEmotion: ENGINE_STATUS.PURE_ENVIRONMENT_SOUND } as any);
         }
      }

      const matchStart = Math.max(0, tStart - 0.5);
      const matchEnd = tEnd + 0.5;
      const matchedFrames = availableFrames.filter(f => f.time >= matchStart && f.time <= matchEnd).map(f => f.path);

      result.shots.push({ id: `shot_text_${Date.now()}_${index}`, mediaId, start: tStart, end: tEnd, originalText: text, aiText: text, contextFrames: matchedFrames, coverPath: matchedFrames.length > 0 ? matchedFrames[0] : (availableFrames[0]?.path || ''), roleId: '', visionText: '', audioEmotion: '' } as any);
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
