import { PathManager } from '../../utils/pathManager'
import { ProcessManager } from '../../utils/processManager'
import { AppLogger } from '../../core/AppLogger'
import { LOG_TAGS } from '@modules/infra/logger/LogConstants'
import { AppError, ErrorCode } from '@modules/infra/error/AppError'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'

export class FrameExtractor {
  /**
   * 从视频中按策略抽取帧
   * @param sourcePath 源视频绝对物理路径
   * @param outputDir  输出帧目录 (由调用方指定 Hash 目录)
   * @param strategy   抽帧策略: uniform(均匀) / keyframe(关键帧) / scene(场景检测) / fps(固定帧率)
   * @param fps        帧率 (仅 strategy=fps 时生效)
   * @param threshold  场景切换阈值 (仅 strategy=scene 时生效)
   */
  async extract(
    sourcePath: string,
    outputDir: string,
    strategy: string = 'uniform',
    fps: number = 1,
    threshold: number = 0.3
  ): Promise<{ frames: string[] }> {
    if (!sourcePath) {
      throw new AppError(ErrorCode.SYS_UNKNOWN, '未提供源文件路径')
    }

    const cleanSourcePath = sourcePath.replace(/^file:{2,3}/, '')
    if (!fs.existsSync(cleanSourcePath)) {
      throw new AppError(ErrorCode.FS_FILE_NOT_FOUND, `物理文件丢失: ${cleanSourcePath}`)
    }

    // P0-2: ffprobe 前置探针 — 校验视频流存在、时长>0、编码兼容
    await this.probeVideo(cleanSourcePath)

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    const ffmpegExe = PathManager.getBinPath(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
    if (!fs.existsSync(ffmpegExe)) {
      throw new AppError(ErrorCode.SYS_UNKNOWN, '系统缺失 FFmpeg 核心引擎')
    }

    const outputPattern = path.join(outputDir, 'frame_%04d.jpg')
    const args: string[] = ['-y', '-i', cleanSourcePath]

    // P2: 统一参数基准 q:v 3、scale=640:-1
    if (strategy === 'iframe' || strategy === 'keyframe') {
      // P0-1: I帧策略加兜底 — 优先I帧，GOP>150帧时每150帧强制采样
      args.push('-vf', "select='eq(pict_type,I)+not(mod(n,150))',scale=640:-1", '-vsync', 'vfr', '-q:v', '3')
    } else if (strategy === 'scene') {
      args.push('-vf', `select='gt(scene,${threshold})',scale=640:-1`, '-vsync', 'vfr', '-q:v', '3')
    } else {
      args.push('-vf', `fps=${fps},scale=640:-1`, '-q:v', '3')
    }
    args.push(outputPattern)

    await this.runFFmpeg(ffmpegExe, args)

    const files = fs.readdirSync(outputDir).filter((f) => f.endsWith('.jpg'))
    AppLogger.info(LOG_TAGS.AI_ENGINE, `[FrameExtractor] 产出 ${files.length} 帧`, { outputDir })

    return { frames: files.map((f) => path.join(outputDir, f)) }
  }

  /**
   * P0-2: ffprobe 前置探针 — 校验视频流存在、时长>0、编码格式兼容
   */
  private probeVideo(filePath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ffprobeExe = PathManager.getBinPath(
        process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
      )
      if (!fs.existsSync(ffprobeExe)) {
        AppLogger.warn(LOG_TAGS.AI_ENGINE, '[FrameExtractor] ffprobe 不可用，跳过前置探针')
        return resolve()
      }

      const child = spawn(ffprobeExe, [
        '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath
      ], { windowsHide: true })

      let stdout = ''
      child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })

      child.on('close', (code: number | null) => {
        if (code !== 0) {
          return reject(
            new AppError(ErrorCode.SYS_UNKNOWN, `ffprobe 无法解析视频文件: ${filePath}`)
          )
        }
        try {
          const data = JSON.parse(stdout)
          const videoStream = data.streams?.find((s: any) => s.codec_type === 'video')
          if (!videoStream) {
            return reject(new AppError(ErrorCode.SYS_UNKNOWN, '文件中未检测到视频流'))
          }
          const duration = parseFloat(data.format?.duration) || 0
          if (duration <= 0) {
            return reject(new AppError(ErrorCode.SYS_UNKNOWN, '视频时长无效 (≤0)'))
          }
          AppLogger.info(LOG_TAGS.AI_ENGINE, `[FrameExtractor] ffprobe OK: ${videoStream.codec_name}, ${duration}s, ${videoStream.width}x${videoStream.height}`)
          resolve()
        } catch {
          reject(new AppError(ErrorCode.SYS_UNKNOWN, 'ffprobe 返回数据解析失败'))
        }
      })

      child.on('error', (err: Error) => {
        reject(new AppError(ErrorCode.SYS_UNKNOWN, `ffprobe 启动失败: ${err.message}`))
      })
    })
  }

  private runFFmpeg(ffmpegExe: string, args: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(ffmpegExe, args)
      let errorLog = ''

      child.stderr.on('data', (data: Buffer) => {
        errorLog += data.toString()
        if (errorLog.length > 2048) errorLog = errorLog.slice(-2048)
      })

      child.on('close', (code: number | null) => {
        if (code !== 0) {
          // P0-2: 非零退出时记录 stderr 最后 500 字符到 AppLogger.error
          const tail = errorLog.slice(-500)
          AppLogger.error(LOG_TAGS.AI_ENGINE, `[FrameExtractor] FFmpeg 非零退出(${code})`, { tail })
          if (
            errorLog.includes('received no packets') ||
            errorLog.includes('Nothing was written')
          ) {
            resolve()
            return
          }
          reject(
            new AppError(
              ErrorCode.SYS_UNKNOWN,
              `FFmpeg 崩溃(${code})。日志: ${tail}`
            )
          )
        } else {
          resolve()
        }
      })

      child.on('error', (err: Error) => {
        AppLogger.error(LOG_TAGS.AI_ENGINE, `[FrameExtractor] FFmpeg 进程异常: ${err.message}`)
        reject(new AppError(ErrorCode.SYS_UNKNOWN, `FFmpeg 唤醒失败: ${err.message}`))
      })

      ProcessManager.register(child, 'frame-extractor')
    })
  }
}
