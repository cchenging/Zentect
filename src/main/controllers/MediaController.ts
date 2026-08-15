// 📁 路径: src/main/controllers/MediaController.ts
// P0 · 契约收拢：抽帧策略统一走 normalizeFrameStrategy 归一化为 2 枚举；
// PRECISE_SINGLE 不再作为抽帧策略，改由 MEDIA_SCREENSHOT_AT 独立 API 提供。
import { dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { IpcRouter } from '../core/IpcRouter';
import { JobScheduler } from '../core/JobScheduler';
import { IPC_CHANNELS } from '../../modules/infra/ipc/IpcConstants';
import { AppError, ErrorCode } from '../../modules/infra/error/AppError';
import { ALL_MEDIA_EXTENSIONS } from '../../modules/infra/i18n/dictionary';
import { MediaService } from '../services/MediaService';
import { PathManager } from '../utils/pathManager';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import { VideoProcessor } from '../engine/media/VideoProcessor';
// P0 · 抽帧契约唯一真源（含兼容映射）
import { normalizeFrameStrategy, type DensityPreset } from '../../modules/media/frames';

export class MediaController {
  private mediaService = new MediaService();

  public register() {
    IpcRouter.handle(IPC_CHANNELS.MEDIA_IMPORT, async (_, projectId: string, filePaths: string[]) => {
      if (!projectId) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, 'Project ID is required');
      }

      if (!filePaths || filePaths.length === 0) {
        const { canceled, filePaths: selectedPaths } = await dialog.showOpenDialog({
          title: '导入媒体素材',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Media Files', extensions: [...ALL_MEDIA_EXTENSIONS] }]
        });
        if (canceled || selectedPaths.length === 0) {
          return [];
        }
        filePaths = selectedPaths;
      }

      const newMediaItems = await this.mediaService.importMedia(projectId, filePaths, PathManager, VideoProcessor);

      // 补全封面字段一致性
      if (Array.isArray(newMediaItems)) {
        return newMediaItems.map(m => {
          const obj = JSON.parse(JSON.stringify(m));
          if (obj.coverPath && !obj.cover) obj.cover = obj.coverPath;
          if (obj.cover && !obj.coverPath) obj.coverPath = obj.cover;
          return obj;
        });
      }
      return newMediaItems;
    });

    IpcRouter.handle(IPC_CHANNELS.MEDIA_UPDATE, async (_, mediaId: string, data: any) => {
      if (!mediaId) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, 'Media ID is required');
      }
      await this.mediaService.updateMedia(mediaId, data);
      return { success: true };
    });

    IpcRouter.handle(IPC_CHANNELS.MEDIA_PROCESS, async (_, projectId: string, activeMedia: any, config: any) => {
      if (!activeMedia || !activeMedia.filePath) {
        throw new AppError(ErrorCode.FS_FILE_NOT_FOUND, 'Invalid media file path');
      }
      /** 将 magic:// URL 还原为物理绝对路径，FFmpeg 无法识别 magic:// 协议 */
      let physicalPath = activeMedia.filePath;
      const projectDir = PathManager.getProjectDir(projectId);
      if (physicalPath.startsWith('magic://')) {
        const prefix = `magic://${projectId}/`;
        if (physicalPath.startsWith(prefix)) {
          /** 项目内相对路径：magic://{projectId}/videos/xxx.mp4 → videos/xxx.mp4 */
          const relativePath = physicalPath.replace(prefix, '');
          physicalPath = path.isAbsolute(relativePath) ? relativePath : path.join(projectDir, relativePath);
        } else if (physicalPath.startsWith('magic://local/')) {
          /** 跨盘符绝对路径：magic://local/F:/Videos/test.mp4 → F:\Videos\test.mp4 */
          physicalPath = physicalPath.replace('magic://local/', '').replace(/\//g, '\\');
        } else {
          /** 兜底：无法识别的 magic:// 格式，拼接项目目录 */
          physicalPath = path.join(projectDir, physicalPath.replace(/^magic:\/\/[^/]+\//, ''));
        }
        AppLogger.info(LOG_TAGS.MEDIA_ENGINE, '[MediaController] magic:// 路径脱水完成', { original: activeMedia.filePath, physicalPath });
      }
      const scheduler = JobScheduler.getInstance();
      scheduler.addExtractionJob(projectId, activeMedia.id, physicalPath, config);
      return { success: true };
    });

    /**
     * P0 · 轻量抽帧通道：只执行抽帧，不跑全管线
     * 用于前端"开始提取"按钮的即时反馈闭环。
     * 策略统一归一化为 AUTO_ADAPTIVE | UNIFORM_FPS；定点截图请走 MEDIA_SCREENSHOT_AT。
     */
    IpcRouter.handle(IPC_CHANNELS.MEDIA_EXTRACT_FRAMES, async (_, payload: {
      mediaId: string; projectId: string; strategy: string; fps: number;
      sceneThreshold: number; minFrameInterval?: number; timePoint?: number;
      /** P0 新增：抽帧密度预设（预算封顶 SSOT） */
      densityPreset?: DensityPreset;
      /** P0 新增：显式 maxFrames 封顶（调试或 UNIFORM_FPS） */
      maxFrames?: number;
      /** P0 新增：BudgetClipper 超预算容忍度（默认 0.1） */
      budgetToleranceRatio?: number;
      /** P2 新增：声画锚定配置（追加式；默认启用；UNIFORM_FPS gate=空） */
      asrSampling?: import('../../modules/media/frames/backend/AsrAnchorMatcher').AsrAnchoringConfig;
      /** P2 新增：上游 ASR 台词（Step1 ASR 产生）；不传=空数组跳过，不 crash */
      asrLines?: import('../../shared/types/entities/editor').AsrLine[];
    }) => {
      const {
        mediaId, projectId, fps, sceneThreshold, minFrameInterval, timePoint,
        densityPreset, maxFrames, budgetToleranceRatio,
        asrSampling, asrLines,
      } = payload;
      const rawStrategy = payload.strategy;

      // P0 · PRECISE_SINGLE 守卫：定点截图不走批量抽帧主流程
      const isPreciseSingle = (raw: string | null | undefined) => {
        if (!raw) return false;
        const r = String(raw).trim().toLowerCase().replace(/[\s-]/g, '_');
        return r === 'precise_single' || r === 'precise' || r === 'precise_one' || r === 'single_frame';
      };
      if (isPreciseSingle(rawStrategy)) {
        throw new AppError(
          ErrorCode.SYS_INVALID_INPUT,
          `[MediaController] 策略 "${rawStrategy}"（定点截图）已不再作为批量抽帧策略。` +
          `请调用 ${IPC_CHANNELS.MEDIA_SCREENSHOT_AT} 独立 API（传入 timePoint）。`
        );
      }

      if (!mediaId || !projectId) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, 'mediaId 和 projectId 必填');
      }

      /** 从 DB 获取媒体信息 */
      const mediaItem = await this.mediaService.getMediaById(mediaId);
      if (!mediaItem) {
        throw new AppError(ErrorCode.FS_FILE_NOT_FOUND, `媒体资产不存在: ${mediaId}`);
      }

      /** magic:// 路径脱水 */
      let physicalPath = mediaItem.filePath || '';
      const projectDir = PathManager.getProjectDir(projectId);
      if (physicalPath.startsWith('magic://')) {
        const prefix = `magic://${projectId}/`;
        if (physicalPath.startsWith(prefix)) {
          const relativePath = physicalPath.replace(prefix, '');
          physicalPath = path.isAbsolute(relativePath) ? relativePath : path.join(projectDir, relativePath);
        } else if (physicalPath.startsWith('magic://local/')) {
          physicalPath = physicalPath.replace('magic://local/', '').replace(/\//g, '\\');
        } else {
          physicalPath = path.join(projectDir, physicalPath.replace(/^magic:\/\/[^/]+\//, ''));
        }
      }

      if (!fs.existsSync(physicalPath)) {
        throw new AppError(ErrorCode.FS_FILE_NOT_FOUND, `物理文件不存在: ${physicalPath}`);
      }

      /** 构建输出目录：统一走 PathManager 标准路径，确保与全管线一致 */
      const framesDir = path.join(PathManager.getProjectExtractionsDir(projectId, 'frames'), mediaId);
      if (!fs.existsSync(framesDir)) {
        fs.mkdirSync(framesDir, { recursive: true });
      }

      /** P0 · 策略名归一化（所有历史别名 → 2 值枚举） */
      const resolvedStrategy = normalizeFrameStrategy(rawStrategy, 'AUTO_ADAPTIVE');

      /** 调用 VideoProcessor 轻量抽帧（透传 P0 densityPreset / maxFrames / tolerance + P2 asrSampling/asrLines） */
      const telemetry = await VideoProcessor.extractFrames(physicalPath, framesDir, mediaId, {
        strategy: resolvedStrategy,
        fps: fps || 2,
        // sceneThreshold/minFrameInterval 不再强制给默认 → 由 Service 层结合 densityPreset 派生
        sceneThreshold,
        minFrameInterval,
        timePoint,
        // 🎭 追加式后处理：清晰度/黑屏过滤 + 静态去重 + P0 预算封顶，
        //   避免长镜头静态画面按 minFrameInterval 兜底抽出的重复帧污染 DB
        postProcess: true,
        densityPreset,
        maxFrames,
        budgetToleranceRatio,
        // P2：声画锚定（上游传则执行；不传或空数组安全跳过）
        asrSampling,
        asrLines,
      });

      /** 结果写 DB — 帧路径转为 magic:// 协议 */
      const framePaths = telemetry.files || [];
      const magicFramePaths = framePaths.map((p: string) => {
        const relative = path.relative(projectDir, p).replace(/\\/g, '/');
        return `magic://${projectId}/${relative}`;
      });

      await this.mediaService.updateMedia(mediaId, {
        frames: magicFramePaths,
        frameCount: telemetry.metrics?.frameCount || framePaths.length,
        status: 'parsed',
      });

      AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[MediaController] 轻量抽帧完成`, {
        mediaId, strategy: resolvedStrategy, densityPreset, maxFrames,
        frameCount: framePaths.length,
      });

      return {
        success: true,
        frameCount: framePaths.length,
        previewUrls: magicFramePaths.slice(0, 30),
      };
    });

    /**
     * P0 · 新增：定点精准截图独立 API（替代原 PRECISE_SINGLE 策略）。
     * 入参 timePoint 单位为秒（允许小数）。内部复用抽帧能力的 single-seek 子流程，
     * 不经过 BudgetClipper 预算裁剪，直接返回一张或零张截图。
     */
    IpcRouter.handle(IPC_CHANNELS.MEDIA_SCREENSHOT_AT, async (_, payload: {
      mediaId: string;
      projectId: string;
      /** 截图时间点（秒） */
      timePoint: number;
      /** 输出宽度（默认 1024） */
      scale?: number;
      /** JPEG 质量 2-31（越小越好，默认 3） */
      quality?: number;
      /** 可选：输出文件名（不含扩展名）；默认 screenshot_<ms> */
      outputName?: string;
    }) => {
      const { mediaId, projectId, timePoint, scale, quality, outputName } = payload;
      if (!mediaId || !projectId) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, 'mediaId 和 projectId 必填');
      }
      if (typeof timePoint !== 'number' || isNaN(timePoint) || timePoint < 0) {
        throw new AppError(ErrorCode.SYS_INVALID_INPUT, 'timePoint 必须为非负秒数（number）');
      }

      /** 从 DB 获取媒体信息 */
      const mediaItem = await this.mediaService.getMediaById(mediaId);
      if (!mediaItem) {
        throw new AppError(ErrorCode.FS_FILE_NOT_FOUND, `媒体资产不存在: ${mediaId}`);
      }

      /** magic:// 路径脱水 */
      let physicalPath = mediaItem.filePath || '';
      const projectDir = PathManager.getProjectDir(projectId);
      if (physicalPath.startsWith('magic://')) {
        const prefix = `magic://${projectId}/`;
        if (physicalPath.startsWith(prefix)) {
          const relativePath = physicalPath.replace(prefix, '');
          physicalPath = path.isAbsolute(relativePath) ? relativePath : path.join(projectDir, relativePath);
        } else if (physicalPath.startsWith('magic://local/')) {
          physicalPath = physicalPath.replace('magic://local/', '').replace(/\//g, '\\');
        } else {
          physicalPath = path.join(projectDir, physicalPath.replace(/^magic:\/\/[^/]+\//, ''));
        }
      }

      if (!fs.existsSync(physicalPath)) {
        throw new AppError(ErrorCode.FS_FILE_NOT_FOUND, `物理文件不存在: ${physicalPath}`);
      }

      /** 构建输出目录：与 frames 输出同级，保持 DB frames 协议一致 */
      const framesDir = path.join(PathManager.getProjectExtractionsDir(projectId, 'frames'), mediaId);
      if (!fs.existsSync(framesDir)) {
        fs.mkdirSync(framesDir, { recursive: true });
      }

      // P0 · screenshotAt 骨架：内部走 extractFrames + UNIFORM_FPS + timePoint 定点，
      // 但不经过 BudgetClipper（定点截图不存在预算概念）。
      // 决策点①：定点截图保留 scale/quality 控件（交互/导出层，非同 Pipeline 抽帧）。
      //  - scale → frameCap：交 resolveGoldenWidth 处理，源长边大于 scale 才缩，否则保持原始（不放大）
      //  - quality → jpegQuality：覆盖输出 JPEG 画质（-q:v），缺省回落系统黄金值 2
      const telemetry = await VideoProcessor.extractFrames(physicalPath, framesDir, mediaId, {
        // P0 约定：定点截图内部仍走 AUTO_ADAPTIVE 策略 + 传 timePoint，
        // Strategy.buildExtractCommand() 会生成单帧 seek 命令；
        // 显式关闭后处理 BudgetClipper 不会影响单张，但我们也传 densityPreset 为 undefined。
        strategy: 'AUTO_ADAPTIVE',
        fps: 1,
        timePoint,
        frameCap: scale,
        jpegQuality: quality,
        // 定点截图：关闭追加式后处理里的 BudgetClipper（虽然这里只有一张）
        postProcess: false,
      });

      const framePaths = telemetry.files || [];
      if (framePaths.length === 0) {
        throw new AppError(ErrorCode.MEDIA_PARSE_FAILED, `截图失败：无法在 timePoint=${timePoint}s 处抽取帧`);
      }
      const outputAbs = framePaths[0];

      /** 如需重命名 */
      let finalAbs = outputAbs;
      if (outputName) {
        const dest = path.join(path.dirname(outputAbs), `${outputName.replace(/[^\w\-\u4e00-\u9fff.]/g, '_')}.jpg`);
        try {
          if (fs.existsSync(dest)) fs.unlinkSync(dest);
          fs.renameSync(outputAbs, dest);
          finalAbs = dest;
        } catch (err) {
          AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[screenshotAt] 重命名失败，使用原文件名`, { err });
        }
      }

      /** 相对路径 → magic:// 协议 */
      const relative = path.relative(projectDir, finalAbs).replace(/\\/g, '/');
      const magicPath = `magic://${projectId}/${relative}`;

      AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[MediaController] 定点截图完成`, {
        mediaId, timePoint, sizeMB: telemetry.metrics?.totalSizeMB || 0,
      });

      return {
        success: true,
        framePath: magicPath,
        sizeBytes: telemetry.metrics?.totalSizeMB ? Math.round(telemetry.metrics.totalSizeMB * 1024 * 1024) : 0,
      };
    });

    IpcRouter.handle(IPC_CHANNELS.MEDIA_CANCEL, async (_, mediaId: string) => {
      const scheduler = JobScheduler.getInstance();
      scheduler.cancelJob(mediaId);
      return { success: true };
    });

    IpcRouter.handle(IPC_CHANNELS.MEDIA_DELETE, async (_, projectId: string, mediaId: string) => {
      if (!projectId || !mediaId) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, 'Project ID and Media ID are required');
      }
      const success = await this.mediaService.deleteMedia(projectId, mediaId);
      return { success };
    });

    IpcRouter.handle(IPC_CHANNELS.MEDIA_GET_BY_PROJECT, async (_, projectId: string) => {
      if (!projectId) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, 'Project ID is required');
      }
      
      const medias = await this.mediaService.getMediaByProject(projectId);

      const mappedMedias = medias.map(m => {
        const obj = JSON.parse(JSON.stringify(m));
        const rawCover = obj.cover || obj.coverPath || '';
        
        if (rawCover) {
          if (!/^magic:\/\//i.test(rawCover) && !/^(https?:\/\/|file:\/\/|data:image)/i.test(rawCover) && !path.isAbsolute(rawCover)) {
            const fileName = rawCover.includes('/') || rawCover.includes('\\')
              ? rawCover.replace(/^thumbnails\//i, '')
              : rawCover;
            obj.cover = `magic://${projectId}/thumbnails/${fileName}`;
            obj.coverPath = obj.cover;
          } else if (!/^magic:\/\//i.test(rawCover)) {
            obj.cover = rawCover;
            obj.coverPath = rawCover;
          }
        }
        return obj;
      });

      return { success: true, data: mappedMedias };
    });
  }
}
