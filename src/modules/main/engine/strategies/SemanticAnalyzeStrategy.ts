import { BaseNodeStrategy, ExecutionContext } from './BaseNodeStrategy';
import { PipelineTask } from '../../../shared/types';
import { AIDaemon } from '../../core/AIDaemon';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '../../../infra/logger/LogConstants';
import { PathManager } from '../../utils/pathManager';
import * as path from 'path';
import * as fs from 'fs';

/**
 * 镜头匹配策略：三维一体弹性时间轴对齐
 * 维度一：解说词与视频片段的 CLIP 语义相似度
 * 维度二：刚性音频时长与视频片段原长的时差惩罚
 * 维度三：BGM 鼓点磁吸吸附权重
 * 使用匈牙利算法求解全局最优排他性匹配
 */
export class SemanticAnalyzeStrategy extends BaseNodeStrategy {
  readonly nodeType = 'semantic-analyze';

  protected async performTask(
    task: PipelineTask,
    context: ExecutionContext,
    cacheDir: string,
    onProgress: (p: number, s: string) => void
  ): Promise<any> {
    /** BaseNodeStrategy 将 params 和 mergedInputs 合并为扁平对象，直接从顶层取值 */
    const mediaPath = task.mediaPath;
    if (!mediaPath) throw new Error('语义分析失败：未找到媒体文件路径');

    /** 从前端注入的参数中获取解说文案段落 */
    const scriptShots: any[] = task.scriptShots || [];
    /** TTS 配音刚性时长数据 */
    const ttsDurations: any[] = task.ttsDurations || [];
    /** BGM 信息 */
    const bgmInfo: { id: string; filePath: string } | null = task.bgmInfo || null;

    onProgress(5, '正在准备镜头匹配数据...');

    /** 如果没有解说文案，无法匹配 */
    if (scriptShots.length === 0) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, '[镜头匹配] 未找到解说文案，跳过匹配');
      return { matches: [], segments: [] };
    }

    /** 步骤1：检测 BGM 鼓点节拍 */
    let bgmBeats: number[] = [];
    if (bgmInfo?.filePath && fs.existsSync(bgmInfo.filePath)) {
      onProgress(10, '正在检测 BGM 节拍...');
      try {
        const beatResult = await AIDaemon.getInstance().post('/api/audio/detect_beats', {
          file_path: bgmInfo.filePath,
        });
        const beatData = beatResult?.data || beatResult;
        bgmBeats = (beatData.beatGridMs || beatData.onsetMs || []).map((ms: number) => ms / 1000);
        AppLogger.info(LOG_TAGS.AI_AGENT, `[镜头匹配] BGM 节拍检测完成，共 ${bgmBeats.length} 个节拍`);
      } catch (e: any) {
        AppLogger.warn(LOG_TAGS.AI_AGENT, `[镜头匹配] BGM 节拍检测失败: ${e.message}，继续无 BGM 模式`);
      }
    }

    /** 步骤2：检测视频场景切片 */
    onProgress(20, '正在检测视频场景切片...');
    let videoChunks: any[] = [];
    try {
      const chunksDir = path.join(cacheDir, 'video_chunks');
      const chunkResult = await AIDaemon.getInstance().post('/api/video/detect_scene_chunks', {
        file_path: mediaPath,
        output_dir: chunksDir,
        threshold: 0.3,
        min_chunk_duration_sec: 1.0,
      });
      const chunkData = chunkResult?.data || chunkResult;
      videoChunks = Array.isArray(chunkData) ? chunkData : [];
      AppLogger.info(LOG_TAGS.AI_AGENT, `[镜头匹配] 场景切片检测完成，共 ${videoChunks.length} 个切片`);
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[镜头匹配] 场景切片检测失败: ${e.message}，回退到帧匹配模式`);
    }

    /** 步骤3：构建 KM 匹配请求 */
    onProgress(40, `正在匹配 ${scriptShots.length} 段文案与画面...`);

    /** 构造带音频时长的 query 列表 */
    const queries = scriptShots.map((s: any, i: number) => {
      /** 从 ttsResults 中查找对应的音频时长 */
      const ttsResult = ttsDurations[i] || ttsDurations.find((t: any) => t.shotId === (s.shotId || s.id));
      const audioDurationMs = ttsResult?.duration ? ttsResult.duration * 1000 : 0;

      return {
        shotId: s.shotId || s.id || `para_${i}`,
        text: s.text || s.content || s.narration || '',
        audioDurationMs,
      };
    }).filter(q => q.text.trim().length > 0);

    if (queries.length === 0) {
      return { matches: [], segments: [] };
    }

    /** 步骤4：调用 KM 全局排他性匹配算法 */
    try {
      const kmResult = await AIDaemon.getInstance().post('/api/solver/kuhn_munkres_match', {
        queries,
        videoChunks,
        bgmBeats,
        alpha: 0.6,
        beta: 0.3,
        gamma: 0.1,
      });

      onProgress(80, '匹配完成，正在整理结果...');

      /** 将匹配结果转换为前端需要的格式 */
      const matchData = kmResult?.results || kmResult?.data || [];
      const matches = queries.map((q, i) => {
        const matched = matchData.find((m: any) => m.shotId === q.shotId);
        if (matched) {
          return {
            shotId: q.shotId,
            mediaType: 'video_chunk' as const,
            mediaId: matched.chunkId || '',
            score: matched.confidence || 0,
            thumbnail: matched.coverPath || '',
            chunkData: matched.chunkData || null,
            audioDurationMs: matched.audioDurationMs || q.audioDurationMs,
            videoTimelineStartMs: matched.videoTimelineStartMs || 0,
            videoTimelineEndMs: matched.videoTimelineEndMs || 0,
            appliedSpeedFactor: matched.appliedSpeedFactor || 1.0,
            confirmed: matched.confidence >= 0.88,
          };
        }
        /** 未匹配到的段落 */
        return {
          shotId: q.shotId,
          mediaType: 'video_chunk' as const,
          mediaId: '',
          score: 0,
          thumbnail: '',
          chunkData: null,
          audioDurationMs: q.audioDurationMs,
          videoTimelineStartMs: 0,
          videoTimelineEndMs: 0,
          appliedSpeedFactor: 1.0,
          confirmed: false,
        };
      });

      onProgress(100, '镜头匹配完成');
      return { matches, segments: matchData, videoChunks, bgmBeats };
    } catch (e: any) {
      AppLogger.error(LOG_TAGS.AI_AGENT, 'KM 匹配算法失败，回退到 CLIP 帧匹配', e);

      /** 回退：使用原有的 CLIP 帧匹配 */
      return await this.fallbackFrameMatch(queries, cacheDir, onProgress);
    }
  }

  /** 回退到原有的 CLIP 帧匹配模式 */
  private async fallbackFrameMatch(
    queries: { shotId: string; text: string; audioDurationMs: number }[],
    cacheDir: string,
    onProgress: (p: number, s: string) => void
  ): Promise<any> {
    onProgress(50, '回退到 CLIP 帧匹配模式...');

    /** 查找帧画面目录 */
    let framesDir = cacheDir;
    const altDirs = [
      path.join(cacheDir, '..', 'vision-1', 'frames'),
      path.join(cacheDir, 'frames'),
    ];
    for (const dir of altDirs) {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png|bmp)$/i.test(f));
        if (files.length > 0) {
          framesDir = dir;
          break;
        }
      }
    }

    try {
      const result = await AIDaemon.getInstance().post('/api/match', {
        queries: queries.map(q => ({ shotId: q.shotId, text: q.text })),
        frames_dir: framesDir,
      });

      const matchData = result?.data || [];
      const matches = queries.map(q => {
        const matched = matchData.find((m: any) => m.shotId === q.shotId);
        const matchedFrame = matched?.matchedFrame || '';
        const thumbnail = matchedFrame ? path.join(framesDir, matchedFrame) : '';

        return {
          shotId: q.shotId,
          mediaType: 'frame' as const,
          mediaId: matchedFrame || '',
          score: matched ? 0.5 : 0,
          thumbnail,
          chunkData: null,
          audioDurationMs: q.audioDurationMs,
          videoTimelineStartMs: 0,
          videoTimelineEndMs: 0,
          appliedSpeedFactor: 1.0,
          confirmed: false,
        };
      });

      onProgress(100, '帧匹配完成（回退模式）');
      return { matches, segments: matchData };
    } catch (e: any) {
      AppLogger.error(LOG_TAGS.AI_AGENT, '镜头匹配服务调用失败', e);
      throw new Error('镜头匹配服务异常: ' + (e.message || '未知错误'));
    }
  }
}
