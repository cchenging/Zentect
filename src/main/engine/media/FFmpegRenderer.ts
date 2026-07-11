// 📁 新建文件: src/main/engine/media/FFmpegRenderer.ts
// V1.2: 独立 FFmpeg MP4 渲染管线 — 不依赖剪映，直接输出上传级 MP4

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PathManager } from '../../utils/pathManager';
import { ProcessManager } from '../../utils/processManager';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '../../../modules/infra/logger/LogConstants';

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
  /** 动态视频切片数据（含毫秒级 startMs/endMs） */
  chunkData?: {
    filePath: string;
    startMs: number;
    endMs: number;
    durationMs: number;
    [key: string]: any;
  } | null;
  /** 变速因子（1.0=正常，<1.0=慢放，>1.0=快进） */
  speedFactor?: number;
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

  /**
   * 物理级别多视频动态切片与光流变速终极混合渲染管线
   * 使用 -filter_complex 多输入一次性渲染，避免中间文件
   * @param matchResults 经由步骤5决策完成的视听卡点互锁序列数组
   * @param sourceVideoPath 原始长视频路径
   * @param outputVideoPath 最终成品视频导出物理路径
   * @param bgmPath 可选 BGM 音频路径
   * @param ttsAudioPaths 可选 TTS 配音路径数组（与 matchResults 一一对应）
   */
  async renderCinematicVideo(
    matchResults: any[],
    sourceVideoPath: string,
    outputVideoPath: string,
    bgmPath?: string,
    ttsAudioPaths?: string[]
  ): Promise<RenderResult> {
    this.isAborted = false;
    const startTime = Date.now();

    if (!this.isAvailable()) {
      return { success: false, outputPath: '', duration: 0, error: 'FFmpeg.exe 未找到' };
    }

    if (matchResults.length === 0) {
      return { success: false, outputPath: '', duration: 0, error: '无匹配结果' };
    }

    try {
      AppLogger.info(LOG_TAGS.EXPORT, `[FFmpeg物理混剪线] 开始拼装高级命令网络，共 ${matchResults.length} 个镜头`);

      const inputArgs: string[] = [];
      const filterParts: string[] = [];
      const concatInputs: string[] = [];

      /** 1. 逐个镜头解析步骤5打入的物理动态切片参数 */
      matchResults.forEach((match, idx) => {
        const chunk = match.chunkData;
        const speedFactor = match.appliedSpeedFactor || 1.0;

        if (!chunk) {
          AppLogger.warn(LOG_TAGS.EXPORT, `[FFmpeg物理混剪线] 镜头 ${match.shotId} 无 chunkData，跳过`);
          return;
        }

        /** 刚性毫秒轴裁剪控制：利用 -ss 与 -to 精准定位原始长视频流的动态区间 */
        const startSec = (chunk.startMs / 1000).toFixed(3);
        const endSec = (chunk.endMs / 1000).toFixed(3);

        /** 每个镜头作为独立输入流 */
        inputArgs.push('-ss', startSec, '-to', endSec, '-i', sourceVideoPath);

        /** 2. 注入多模态核心滤镜：光流法高级慢动作运动估计补间网格 (Minterpolate) */
        const setpts = (1 / speedFactor).toFixed(4);
        let videoFilter = `[${idx}:v]setpts=${setpts}*PTS`;

        if (speedFactor < 0.95) {
          /** 行业最高标光流补间算子：动态估算宏块运动向量进行像素级无损插值 */
          videoFilter += ',minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:vsbmc=1';
        }

        /** 统一缩放和帧率 */
        videoFilter += ',scale=1920:1080,fps=60';
        videoFilter += `[v${idx}]`;

        filterParts.push(videoFilter);
        concatInputs.push(`[v${idx}]`);
      });

      if (filterParts.length === 0) {
        return { success: false, outputPath: '', duration: 0, error: '无有效镜头数据' };
      }

      /** 3. 完美的视听多路合并网络拼接 */
      const concatFilter = `${concatInputs.join('')}concat=n=${filterParts.length}:v=1:a=0[v_out]`;
      const fullFilterComplex = `${filterParts.join(';')};${concatFilter}`;

      /** 4. 构建 FFmpeg 命令 */
      const cmdArgs: string[] = [
        '-y',
        ...inputArgs,
        '-filter_complex', fullFilterComplex,
        '-map', '[v_out]',
      ];

      /** 5. 可选：混入 BGM 音频 */
      if (bgmPath && fs.existsSync(bgmPath)) {
        cmdArgs.push('-i', bgmPath);
        const bgmInputIdx = filterParts.length; // BGM 是最后一个输入
        cmdArgs.push('-map', `${bgmInputIdx}:a`, '-c:a', 'aac', '-b:a', '128k');
      }

      /** 6. 视频编码参数 */
      cmdArgs.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '18');
      cmdArgs.push(outputVideoPath);

      AppLogger.info(LOG_TAGS.EXPORT, `[FFmpeg物理混剪线] 执行渲染命令，${filterParts.length} 个镜头`);

      /** 7. 执行渲染 */
      await this.execFfmpeg(cmdArgs);

      const duration = Date.now() - startTime;
      AppLogger.info(LOG_TAGS.EXPORT, `[FFmpeg物理混剪线] 电影级视听卡点视频导出成功: ${outputVideoPath} (${(duration / 1000).toFixed(1)}s)`);

      return { success: true, outputPath: outputVideoPath, duration };
    } catch (err: any) {
      AppLogger.error(LOG_TAGS.EXPORT, '[FFmpeg物理混剪线] 渲染失败', err);
      return { success: false, outputPath: '', duration: 0, error: err.message };
    }
  }

  /** 步骤 1: 逐个镜头截取视频片段，支持 chunkData 精确截取和变速 */
  private async cutSegments(job: RenderJob, workDir: string): Promise<string[]> {
    const segments: string[] = [];

    for (let i = 0; i < job.shots.length; i++) {
      if (this.isAborted) break;
      const shot = job.shots[i];
      const speedFactor = shot.speedFactor || 1.0;
      const needsReencode = speedFactor !== 1.0;

      /** 优先使用 chunkData 的毫秒级时间戳，否则回退到 startTime/endTime（秒） */
      const startSec = shot.chunkData?.startMs != null
        ? shot.chunkData.startMs / 1000
        : shot.startTime;
      const endSec = shot.chunkData?.endMs != null
        ? shot.chunkData.endMs / 1000
        : shot.endTime;
      const duration = endSec - startSec;
      if (duration <= 0) continue;

      /** 变速片段用 mp4 重编码，普通片段用 ts 流复制 */
      const segExt = needsReencode ? 'mp4' : 'ts';
      const segPath = path.join(workDir, `seg_${String(i).padStart(3, '0')}.${segExt}`);
      this.reportProgress(job, 5 + (i / job.shots.length) * 15, `截取镜头 ${i + 1}/${job.shots.length}`, i + 1);

      try {
        if (needsReencode) {
          /** 变速模式：需要重编码 + 变速滤镜 */
          const videoFilter: string[] = [];
          const audioFilter: string[] = [];

          /** 视频变速：setpts=PTS*factor（factor<1 快进，>1 慢放） */
          videoFilter.push(`setpts=PTS*${speedFactor.toFixed(4)}`);

          /** 音频变速：atempo 限制在 [0.5, 2.0]，超出范围需链式组合 */
          let atempo = 1.0 / speedFactor;
          const atempoChain: string[] = [];
          while (atempo > 2.0) {
            atempoChain.push('atempo=2.0');
            atempo /= 2.0;
          }
          while (atempo < 0.5) {
            atempoChain.push('atempo=0.5');
            atempo /= 0.5;
          }
          atempoChain.push(`atempo=${atempo.toFixed(4)}`);
          audioFilter.push(atempoChain.join(','));

          /** 极端慢放（factor > 1.5）时启用光流补帧 */
          if (speedFactor > 1.5) {
            videoFilter.push('minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir');
          }

          await this.execFfmpeg([
            '-y', '-ss', startSec.toString(),
            '-i', job.mediaPath,
            '-t', duration.toString(),
            '-vf', videoFilter.join(','),
            '-af', audioFilter.join(','),
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
            '-c:a', 'aac', '-b:a', '128k',
            '-avoid_negative_ts', 'make_zero',
            segPath,
          ]);
        } else {
          /** 普通模式：流复制，不重编码 */
          await this.execFfmpeg([
            '-y', '-ss', startSec.toString(),
            '-i', job.mediaPath,
            '-t', duration.toString(),
            '-c', 'copy',
            '-avoid_negative_ts', 'make_zero',
            segPath,
          ]);
        }

        if (fs.existsSync(segPath) && fs.statSync(segPath).size > 0) {
          segments.push(segPath);
        }
      } catch (err: any) {
        AppLogger.warn(LOG_TAGS.EXPORT, `[FFmpegRenderer] 镜头 ${shot.id} 截取失败:`, err.message);
      }
    }
    return segments;
  }

  /** 步骤 2: 使用 concat 协议串联所有片段（兼容混合 ts/mp4 格式） */
  private async concatSegments(segments: string[], workDir: string): Promise<string> {
    const concatFile = path.join(workDir, 'concat_list.txt');
    const concatContent = segments.map(s => `file '${s.replace(/\\/g, '/')}'`).join('\n');
    fs.writeFileSync(concatFile, concatContent, 'utf-8');

    /** 检查是否有变速片段（mp4 格式），如果有则统一重编码 concat */
    const hasReencoded = segments.some(s => s.endsWith('.mp4'));
    const outputPath = path.join(workDir, 'video_only.ts');

    if (hasReencoded) {
      /** 混合格式：必须重编码 concat */
      await this.execFfmpeg([
        '-y', '-f', 'concat', '-safe', '0',
        '-i', concatFile,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        outputPath,
      ]);
    } else {
      /** 纯 TS 格式：流复制 concat */
      await this.execFfmpeg([
        '-y', '-f', 'concat', '-safe', '0',
        '-i', concatFile,
        '-c', 'copy',
        outputPath,
      ]);
    }
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
