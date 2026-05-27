// 📁 新建文件: src/main/engine/media/FFmpegRenderer.ts
// V1.2: 独立 FFmpeg MP4 渲染管线 — 不依赖剪映，直接输出上传级 MP4

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PathManager } from '../../utils/pathManager';
import { ProcessManager } from '../../utils/processManager';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '../../../shared/utils/LogConstants';

/** 渲染作业数据结构 */
export interface RenderJob {
  projectId: string;
  mediaPath: string;                    // 源视频文件绝对路径
  shots: RenderShot[];
  bgmPath?: string;                     // 可选背景音乐
  subtitlePath?: string;                // 可选字幕 SRT 文件路径
  outputDir: string;                    // 输出目录
  outputName?: string;                  // 输出文件名（不含扩展名）
  onProgress?: (progress: RenderProgress) => void;
}

/** 单个镜头的数据 */
export interface RenderShot {
  id: string;
  startTime: number;                    // 起始时间（秒）
  endTime: number;                     // 结束时间（秒）
  ttsAudioPath?: string;               // 该镜头的 TTS 配音
  subtitle?: string;                   // 字幕文本（备用，优先用 SRT）
}

/** 渲染进度回调 */
export interface RenderProgress {
  percent: number;
  step: string;
  currentShot: number;
  totalShots: number;
}

/** 渲染结果 */
export interface RenderResult {
  success: boolean;
  outputPath: string;
  duration: number;
  error?: string;
}

export class FFmpegRenderer {
  private ffmpegExe: string;
  private isAborted = false;
  /** 当前正在运行的 FFmpeg 子进程引用，abort 时需要 kill */
  private activeChild: import('child_process').ChildProcess | null = null;

  constructor() {
    this.ffmpegExe = PathManager.getBinPath('ffmpeg.exe');
  }

  /** 终止当前渲染，kill 子进程防止僵尸进程 */
  abort(): void {
    this.isAborted = true;
    if (this.activeChild && !this.activeChild.killed) {
      this.activeChild.kill('SIGTERM');
      // Windows 下 SIGTERM 可能不生效，强制 kill
      setTimeout(() => {
        if (this.activeChild && !this.activeChild.killed) {
          this.activeChild.kill('SIGKILL');
        }
      }, 2000);
      AppLogger.warn(LOG_TAGS.EXPORT, '[FFmpegRenderer] 已终止 FFmpeg 子进程');
    }
    AppLogger.warn(LOG_TAGS.EXPORT, '[FFmpegRenderer] 收到中止信号');
  }

  /** 检查 FFmpeg 是否可用 */
  isAvailable(): boolean {
    return fs.existsSync(this.ffmpegExe);
  }

  /** 执行完整 MP4 渲染流水线 */
  async render(job: RenderJob): Promise<RenderResult> {
    this.isAborted = false;

    if (!this.isAvailable()) {
      return { success: false, outputPath: '', duration: 0, error: 'FFmpeg.exe 未找到' };
    }

    const startTime = Date.now();
    const workDir = path.join(job.outputDir, '.render_temp');
    const outputName = job.outputName || `output_${Date.now()}`;
    const outputPath = path.join(job.outputDir, `${outputName}.mp4`);

    try {
      if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
      this.reportProgress(job, 0, '初始化渲染环境', 0);

      // 步骤 1: 逐镜头截取视频片段
      const segments = await this.cutSegments(job, workDir);
      if (this.isAborted) return this.fail(outputPath, '用户中止');
      if (segments.length === 0) return this.fail(outputPath, '无可用的视频片段');

      // 步骤 2: 串联视频片段
      this.reportProgress(job, 20, '串联视频片段', 0);
      const videoOnlyPath = await this.concatSegments(segments, workDir);
      if (this.isAborted) return this.fail(outputPath, '用户中止');

      // 步骤 3: 处理音频轨（TTS 配音 + BGM）
      this.reportProgress(job, 40, '混合音频轨道', 0);
      const audioMixPath = await this.mixAudio(job, workDir);
      if (this.isAborted) return this.fail(outputPath, '用户中止');

      // 步骤 4: 合成最终 MP4
      this.reportProgress(job, 60, '合成最终 MP4', 0);
      await this.composeFinalVideo(videoOnlyPath, audioMixPath, job.subtitlePath, outputPath);
      if (this.isAborted) return this.fail(outputPath, '用户中止');

      // 步骤 5: 清理临时文件
      this.cleanupTemp(workDir);

      const duration = Date.now() - startTime;
      this.reportProgress(job, 100, '渲染完成', job.shots.length);
      AppLogger.info(LOG_TAGS.EXPORT, `[FFmpegRenderer] MP4 渲染完成: ${outputPath} (${(duration / 1000).toFixed(1)}s)`);

      return { success: true, outputPath, duration };
    } catch (err: any) {
      AppLogger.error(LOG_TAGS.EXPORT, '[FFmpegRenderer] 渲染失败', err);
      this.cleanupTemp(workDir);
      return { success: false, outputPath: '', duration: 0, error: err.message };
    }
  }

  /** 步骤 1: 逐个镜头截取视频片段（使用 copy codec 避免重新编码） */
  private async cutSegments(job: RenderJob, workDir: string): Promise<string[]> {
    const segments: string[] = [];

    for (let i = 0; i < job.shots.length; i++) {
      if (this.isAborted) break;
      const shot = job.shots[i];
      const duration = shot.endTime - shot.startTime;
      if (duration <= 0) continue;

      const segPath = path.join(workDir, `seg_${String(i).padStart(3, '0')}.ts`);
      this.reportProgress(job, 5 + (i / job.shots.length) * 15, `截取镜头 ${i + 1}/${job.shots.length}`, i + 1);

      try {
        await this.execFfmpeg([
          '-y', '-ss', shot.startTime.toString(),
          '-i', job.mediaPath,
          '-t', duration.toString(),
          '-c', 'copy',
          '-avoid_negative_ts', 'make_zero',
          segPath,
        ]);
        if (fs.existsSync(segPath) && fs.statSync(segPath).size > 0) {
          segments.push(segPath);
        }
      } catch (err: any) {
        AppLogger.warn(LOG_TAGS.EXPORT, `[FFmpegRenderer] 镜头 ${shot.id} 截取失败:`, err.message);
      }
    }
    return segments;
  }

  /** 步骤 2: 使用 concat 协议串联所有 TS 片段 */
  private async concatSegments(segments: string[], workDir: string): Promise<string> {
    const concatFile = path.join(workDir, 'concat_list.txt');
    const concatContent = segments.map(s => `file '${s.replace(/\\/g, '/')}'`).join('\n');
    fs.writeFileSync(concatFile, concatContent, 'utf-8');

    const outputPath = path.join(workDir, 'video_only.ts');
    await this.execFfmpeg([
      '-y', '-f', 'concat', '-safe', '0',
      '-i', concatFile,
      '-c', 'copy',
      outputPath,
    ]);
    return outputPath;
  }

  /** 步骤 3: 混合 TTS 配音轨道（及可选 BGM 降音至 30%） */
  private async mixAudio(job: RenderJob, workDir: string): Promise<string | null> {
    // 收集所有有配音的镜头音频
    const audioInputs: string[] = [];
    const audioDelays: number[] = [];
    let cumulativeTime = 0;

    for (const shot of job.shots) {
      if (shot.ttsAudioPath && fs.existsSync(shot.ttsAudioPath)) {
        audioInputs.push(shot.ttsAudioPath);
        audioDelays.push(cumulativeTime * 1000); // FFmpeg 延迟单位是毫秒
      }
      cumulativeTime += (shot.endTime - shot.startTime);
    }

    if (audioInputs.length === 0) return null;

    const outputPath = path.join(workDir, 'mixed_audio.aac');
    const args: string[] = ['-y'];

    // 添加所有音频输入
    for (const input of audioInputs) {
      args.push('-i', input);
    }

    // 构建 amix 滤镜：混合所有轨道，每轨延迟到对应时间点
    const filterParts = audioInputs.map((_, i) => {
      const delayMs = audioDelays[i];
      return `[${i}:a]adelay=${delayMs}|${delayMs}[a${i}]`;
    });

    const inputs = audioInputs.map((_, i) => `[a${i}]`).join('');
    const amixInputs = audioInputs.length;
    filterParts.push(`${inputs}amix=inputs=${amixInputs}:duration=longest[aout]`);

    args.push('-filter_complex', filterParts.join(';'));
    args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', outputPath);

    await this.execFfmpeg(args);

    // 如果有 BGM，再混入（降音到 30%）
    if (job.bgmPath && fs.existsSync(job.bgmPath)) {
      const finalPath = path.join(workDir, 'mixed_audio_final.aac');
      await this.execFfmpeg([
        '-y',
        '-i', outputPath,
        '-i', job.bgmPath,
        '-filter_complex', '[0:a]volume=1[a1];[1:a]volume=0.3[a2];[a1][a2]amix=inputs=2:duration=first[aout]',
        '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k',
        finalPath,
      ]);
      return finalPath;
    }

    return outputPath;
  }

  /** 步骤 4: 合成视频轨 + 音频轨 + 可选字幕烧录 → 最终 MP4 */
  private async composeFinalVideo(
    videoPath: string,
    audioPath: string | null,
    subtitlePath: string | undefined,
    outputPath: string,
  ): Promise<void> {
    const args: string[] = ['-y', '-i', videoPath];

    if (audioPath) {
      args.push('-i', audioPath);
    }

    // 视频编码参数
    const videoFilter: string[] = [];
    if (subtitlePath && fs.existsSync(subtitlePath)) {
      // 烧录字幕（路径需要转义冒号）
      const escapedSubPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
      videoFilter.push(`subtitles='${escapedSubPath}'`);
    }

    if (videoFilter.length > 0) {
      args.push('-vf', videoFilter.join(','));
    }

    args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '23');

    if (audioPath) {
      args.push('-c:a', 'aac', '-b:a', '192k', '-map', '0:v:0', '-map', '1:a:0');
    } else {
      args.push('-c:a', 'aac', '-b:a', '192k');
    }

    args.push('-movflags', '+faststart', outputPath);
    await this.execFfmpeg(args);
  }

  /** 执行 FFmpeg 命令并等待完成，abort 时可终止子进程 */
  private execFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const safeArgs = args.filter(a => a !== undefined && a !== null).map(String);
      const child = spawn(this.ffmpegExe, safeArgs, { windowsHide: true });
      this.activeChild = child; // 记录引用，abort 时可 kill

      let stderr = '';
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      child.on('close', (code) => {
        this.activeChild = null; // 进程结束，清除引用
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      });

      child.on('error', (err) => {
        this.activeChild = null;
        reject(err);
      });
      ProcessManager.register(child, 'FFmpeg-Render');
    });
  }

  /** 清理临时文件 */
  private cleanupTemp(workDir: string): void {
    try {
      if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
    } catch { /* 静默 */ }
  }

  /** 发送进度回调 */
  private reportProgress(job: RenderJob, percent: number, step: string, currentShot: number): void {
    job.onProgress?.({ percent, step, currentShot, totalShots: job.shots.length });
  }

  /** 构建失败结果 */
  private fail(outputPath: string, error: string): RenderResult {
    // 尝试清理可能已生成的不完整文件
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
    return { success: false, outputPath: '', duration: 0, error };
  }
}
