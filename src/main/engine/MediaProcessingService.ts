// 📁 路径：src/main/engine/MediaProcessingService.ts
// 从 AIEngine.ts 拆分：媒体处理 / Python 微服务互联（ffprobe / Whisper / 素材搜索 / 人声分离 / 视频抽帧）

import { FrameExtractor } from './capabilities/FrameExtractor';
import { ProcessManager } from '../utils/processManager';
import { PathManager } from '../utils/pathManager';
import { SQLiteConnection } from '../database/core/SQLiteConnection';
import { AIDaemon } from '../core/AIDaemon';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import { ENGINE_STATUS } from '../../modules/infra/i18n/dictionary';
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

  public async recognizeAudio(audioPath: string): Promise<string> {
    try {
      const ffmpegExe = PathManager.getBinPath(PathManager.getExeName('ffmpeg'));
      const whisperExe = PathManager.getBinPath(PathManager.getExeName('whisper-cli'));
      const modelPath = PathManager.getModelPath('whisper', 'ggml-base.bin');
      if (!fs.existsSync(whisperExe) || !fs.existsSync(modelPath)) return ENGINE_STATUS.AI_MODEL_UNDEPLOYED;
      
      const wavPath = audioPath.replace(/\.[^/.]+$/, "_16k.wav");
      let converted = false;
      try {
        await new Promise<void>((resolve, reject) => {
          const process = spawn(ffmpegExe, ['-i', audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath, '-y']);
          process.stderr.on('data', () => {});
          process.on('error', (err) => reject(new Error(`FFmpeg 转换失败: ${err.message}`)));
          process.on('close', (code: number) => code !== 0 ? reject(new Error(`FFmpeg退出码: ${code}`)) : resolve());
        });
        converted = true;
      } catch (err: any) {
        AppLogger.error(LOG_TAGS.AI_ENGINE, `音频转换失败: ${err.message}`);
        return `异常: ${err.message}`;
      }

      let stdout = '';
      try {
        stdout = await new Promise<string>((resolve, reject) => {
          let output = '';
          const process = spawn(whisperExe, ['-m', modelPath, '-f', wavPath, '-l', 'zh']);
          process.stdout.on('data', (data: Buffer) => { output += data.toString(); });
          process.stderr.on('data', () => {});
          process.on('error', (err) => reject(new Error(`Whisper 执行失败: ${err.message}`)));
          process.on('close', (code: number) => code !== 0 ? reject(new Error(`Whisper退出码: ${code}`)) : resolve(output));
        });
      } catch (err: any) {
        AppLogger.error(LOG_TAGS.AI_ENGINE, `Whisper 识别失败: ${err.message}`);
        return `异常: ${err.message}`;
      }

      if (converted && fs.existsSync(wavPath)) { try { fs.unlinkSync(wavPath); } catch {} }
      const lines = stdout.split('\n'); const resultLines: string[] = []; 
      for (const line of lines) {
        const match = line.match(/\[(\d{2}:\d{2}:\d{2})\.\d{3}\s*-->.*\]\s*(.*)/);
        if (match && match[2].trim() && !match[2].trim().startsWith('[')) resultLines.push(`[${match[1]}] ${match[2].trim()}`);
      }
      return resultLines.length > 0 ? resultLines.join('\n') : ENGINE_STATUS.NO_LINES_DETECTED;
    } catch (err: any) { return `异常: ${err.message}`; }
  }

  public async searchBrollLocally(payload: { query: string, projectId: string }) {
    try {
      const res = await AIDaemon.getInstance().post('/api/clip_search', { project_id: payload.projectId, query: payload.query, top_k: 1 });
      return (res && res.success && res.data?.length > 0) ? { success: true, mediaId: res.data[0].media_id } : { success: false, error: '未检索到高匹配度画面' };
    } catch (error: any) { return { success: false, error: error.message }; }
  }

  public async isolateVocalsLocally(_projectId: string, shotId: string) {
    try {
      const db = SQLiteConnection.getInstance().getDB();
      const shot = db.prepare('SELECT media_id, audio_path FROM shots WHERE id = ?').get(shotId) as any;
      if (!shot) throw new Error('未找到镜头');
      
      let sourcePath = shot.audio_path;
      if (!sourcePath) {
        const media = db.prepare('SELECT file_path FROM media_assets WHERE id = ?').get(shot.media_id) as any;
        if (!media) throw new Error('未找到物理素材');
        sourcePath = media.file_path;
      }
      
      const cleanPath = sourcePath.replace(/^file:{2,3}/, '');
      const res = await AIDaemon.getInstance().post('/api/isolate_vocals', { audio_path: cleanPath });
      if (!res.success) throw new Error(res.error || '提取失败');
      
      const audioPath = res.vocal_path || res.vocals_path || '';
      const newAudioUrl = audioPath ? `file://${audioPath.split('\\').join('/')}` : '';
      db.prepare('UPDATE shots SET audio_path = ? WHERE id = ?').run(newAudioUrl, shotId);
      return { success: true, audioPath: newAudioUrl };
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
