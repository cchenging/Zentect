// 📁 路径：src/main/engine/MediaProcessingService.ts
// 从 AIEngine.ts 拆分：媒体处理 / Python 微服务互联（ffprobe / 素材搜索 / 视频抽帧）

import { FrameExtractor } from './capabilities/FrameExtractor';
import { ProcessManager } from '../utils/processManager';
import { PathManager } from '../utils/pathManager';
import { AIDaemon } from '../core/AIDaemon';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import fs from 'fs';
import { spawn } from 'child_process';

export class MediaProcessingService {

  public async getMediaDuration(filePath: string): Promise<number> {
    return new Promise((resolve) => {
      const ffprobeExe = PathManager.getBinPath(PathManager.getExeName('ffprobe'));
      if (!fs.existsSync(ffprobeExe)) return resolve(0);
      const child = spawn(ffprobeExe, [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'csv=p=0', filePath
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
      child.on('close', () => {
        const secs = parseFloat(output.trim());
        resolve(isNaN(secs) ? 0 : secs);
      });
      child.on('error', () => resolve(0));
      ProcessManager.register(child, 'ffprobe-duration');
    });
  }

  public async searchBrollLocally(payload: { query: string, projectId: string }) {
    try {
      const res = await AIDaemon.getInstance().post('/api/clip_search', { project_id: payload.projectId, query: payload.query, top_k: 1 });
      return (res && res.success && res.data?.length > 0) ? { success: true, mediaId: res.data[0].media_id } : { success: false, error: '未检索到高匹配度画面' };
    } catch (error: any) { return { success: false, error: error.message }; }
  }

  /**
   * 💥 工业级 L2 改造：彻底剥离数据库，纯函数化抽帧引擎
   * @param sourcePath 源视频绝对物理路径
   * @param outputDir 输出帧绝对物理目录 (由 PipelineEngine 的 Hash 机制指定)
   * @param strategy 抽帧策略
   * @param fps 帧率
   * @param threshold 场景阈值
   */
  public async extractFramesLocally(
    sourcePath: string, 
    outputDir: string, 
    strategy: string = 'uniform', 
    fps: number = 1,
    threshold: number = 0.3
  ): Promise<{ frames: string[] }> {
    try {
      const extractor = new FrameExtractor();
      return await extractor.extract(sourcePath, outputDir, strategy, fps, threshold);
    } catch (error: any) {
      AppLogger.error(LOG_TAGS.AI_ENGINE, `本地抽帧物理熔断: ${error.message}`, { sourcePath });
      throw error;
    }
  }
}

export const mediaProcessingService = new MediaProcessingService();
