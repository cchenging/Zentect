// 📁 路径：src/main/engine/media/VideoProcessor.ts
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path'; 
import { PathManager } from '../../utils/pathManager';
import { ProcessManager } from '../../utils/processManager';

export interface FrameExtractionOptions {
  inPoint?: number;
  outPoint?: number;
  fps?: number;                                 
  scale?: number;                               
  strategy?: 'uniform' | 'keyframe' | 'scene';  
  sceneThreshold?: number;                      
  abortSignal?: AbortSignal;
}

export interface FrameExtractionTelemetry {
  files: string[];
  metrics: {
    durationMs: number;     
    frameCount: number;     
    totalSizeMB: number;    
    processingFps: number;  
  };
}

export class VideoProcessor {
  static async extractMetadata(filePath: string): Promise<any> {
    return new Promise((resolve) => {
      const ffprobeExe = PathManager.getBinPath('ffprobe.exe');
      if (!filePath) { resolve({ formattedTime: '00:00:00', width: 0, height: 0, fps: 0 }); return; }
      const child = spawn(ffprobeExe, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath], {
        windowsHide: true,
      });
      let stdout = '';
      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.on('close', (code) => {
        if (code !== 0) { resolve({ formattedTime: '00:00:00', width: 0, height: 0, fps: 0 }); return; }
        try {
          const data = JSON.parse(stdout);
          const videoStream = data.streams.find((s: any) => s.codec_type === 'video');
          const duration = parseFloat(data.format.duration) || 0;
          const h = Math.floor(duration / 3600).toString().padStart(2, '0');
          const m = Math.floor((duration % 3600) / 60).toString().padStart(2, '0');
          const s = Math.floor(duration % 60).toString().padStart(2, '0');
          let fps = 0;
          if (videoStream?.r_frame_rate) {
             const [num, den] = videoStream.r_frame_rate.split('/');
             if (num && den && parseInt(den) !== 0) fps = parseInt(num) / parseInt(den);
          }
          resolve({ formattedTime: `${h}:${m}:${s}`, width: videoStream?.width || 0, height: videoStream?.height || 0, fps: fps });
        } catch (e) { resolve({ formattedTime: '00:00:00', width: 0, height: 0, fps: 0 }); }
      });
      child.on('error', () => resolve({ formattedTime: '00:00:00', width: 0, height: 0, fps: 0 }));
      ProcessManager.register(child, 'FFprobe-元数据');
    });
  }

  static async generateCover(videoPath: string, outputDir: string, mediaId: string): Promise<string> {
    return new Promise((resolve) => {
       const safeMediaId = mediaId.replace(/[^\w\-\u4e00-\u9fff]/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
       const coverFileName = `${safeMediaId}.jpg`;

       const coverFullPath = path.join(outputDir, coverFileName);
       const ffmpegExe = PathManager.getBinPath('ffmpeg.exe');

       if (!fs.existsSync(ffmpegExe)) return resolve('');

       const args = [
         '-y',
         '-ss', '00:00:00.100',
         '-i', videoPath,
         '-frames:v', '1',
         '-q:v', '2',
         '-vf', 'scale=-1:360',
         coverFullPath
       ];

       const safeArgs = args
         .filter(a => a !== undefined && a !== null)
         .map(String);

       const child = spawn(ffmpegExe, safeArgs);
       child.on('close', (code) => {
         if (code === 0 && fs.existsSync(coverFullPath)) resolve(coverFileName);
         else resolve('');
       });
       child.on('error', () => resolve(''));
       ProcessManager.register(child, 'FFmpeg-生成封面');
    });
  }

  public static async extractFrames(
    filePath: string, outputDir: string, mediaId: string, 
    options: FrameExtractionOptions = {}
  ): Promise<FrameExtractionTelemetry> {
    const { inPoint, outPoint, fps = 1, scale = 640, strategy = 'uniform', abortSignal } = options;
    
    const safeMediaId = mediaId.replace(/[^\w\-\u4e00-\u9fff]/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
    const safeOutputDir = outputDir.replace(mediaId, safeMediaId);

    if (!fs.existsSync(safeOutputDir)) fs.mkdirSync(safeOutputDir, { recursive: true });
    const ffmpegExe = PathManager.getBinPath('ffmpeg.exe');
    const emptyTelemetry: FrameExtractionTelemetry = { files: [], metrics: { durationMs: 0, frameCount: 0, totalSizeMB: 0, processingFps: 0 } };
    if (!fs.existsSync(ffmpegExe)) return emptyTelemetry;

    const outputPattern = path.join(safeOutputDir, 'frame_%08d.jpg');

    return new Promise((resolve, reject) => {
      const args = ['-y'];
      if (inPoint !== undefined) args.push('-ss', inPoint.toString());
      if (outPoint !== undefined) args.push('-to', outPoint.toString());
      args.push('-i', filePath);

      if (strategy === 'keyframe') {
         args.push('-vf', `select='eq(pict_type,I)',scale=${scale}:-1`, '-vsync', 'vfr');
      } else if (strategy === 'scene') {
         const threshold = options.sceneThreshold || 0.4;
         args.push('-vf', `select='gt(scene,${threshold})',scale=${scale}:-1`, '-vsync', 'vfr');
      } else {
         args.push('-vf', `fps=${fps},scale=${scale}:-1`);
      }

      args.push('-q:v', '5', '-threads', '2', outputPattern);
      
      const startTime = Date.now();
      
      // 💥 绝对防御：清洗一切可能引发 V8 底层类型转换崩溃的脏数据（undefined/null）
      const safeArgs = args
        .filter(a => a !== undefined && a !== null)
        .map(String);
      
      const child = spawn(ffmpegExe, safeArgs);
      
      if (abortSignal) {
        const onAbort = () => { child.kill('SIGKILL'); reject(new Error('TASK_ABORTED')); };
        abortSignal.addEventListener('abort', onAbort);
        child.on('close', () => abortSignal.removeEventListener('abort', onAbort));
        child.on('error', () => abortSignal.removeEventListener('abort', onAbort));
      }

      child.on('close', async () => {
        const durationMs = Date.now() - startTime; 
        try {
          const files = fs.readdirSync(safeOutputDir)
                          .filter(f => f.endsWith('.jpg'))
                          .map(f => path.join(safeOutputDir, f))
                          .sort();
          
          const fileStats = await Promise.all(files.map(f => fs.promises.stat(f).catch(() => ({ size: 0 }))));
          const totalSizeBytes = fileStats.reduce((acc, curr) => acc + curr.size, 0);
          
          const frameCount = files.length;
          const totalSizeMB = Number((totalSizeBytes / (1024 * 1024)).toFixed(2));
          const processingFps = durationMs > 0 ? Number((frameCount / (durationMs / 1000)).toFixed(2)) : 0;

          resolve({
             files,
             metrics: { durationMs, frameCount, totalSizeMB, processingFps }
          });
        } catch (e) { 
          resolve(emptyTelemetry); 
        }
      });
      child.on('error', () => resolve(emptyTelemetry));
    });
  }

  // @todo 实例方法保留接口占位，待接入真实抽帧引擎后移除 mock
  public async extractFrames(_videoPath: string, _config: any): Promise<any[]> {
    throw new Error('extractFrames 实例方法未实现，请使用静态 extractFrames');
  }
}
