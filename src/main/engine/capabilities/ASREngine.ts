import { PathManager } from '../../utils/pathManager'
import { ProcessManager } from '../../utils/processManager'
import { AppLogger } from '../../core/AppLogger'
import { LOG_TAGS } from '../../../shared/utils/LogConstants'
import { ENGINE_STATUS } from '../../../shared/locales/dictionary'
import fs from 'fs'
import { spawn } from 'child_process'

export class ASREngine {
  /**
   * 语音识别 — 本地 Whisper.cpp 推理
   * @param audioPath 音频文件绝对路径
   * @returns 识别文本（带时间戳），失败返回错误提示
   */
  async recognize(audioPath: string): Promise<string> {
    try {
      const ffmpegExe = PathManager.getBinPath(PathManager.getExeName('ffmpeg'))
      const whisperExe = PathManager.getBinPath(PathManager.getExeName('whisper-cli'))
      const modelPath = PathManager.getModelPath('whisper', 'ggml-base.bin')

      if (!fs.existsSync(whisperExe) || !fs.existsSync(modelPath)) {
        return ENGINE_STATUS.AI_MODEL_UNDEPLOYED
      }

      // 转 16kHz 单声道 WAV
      const wavPath = audioPath.replace(/\.[^/.]+$/, '_16k.wav')
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(ffmpegExe, [
          '-i',
          audioPath,
          '-ar',
          '16000',
          '-ac',
          '1',
          '-c:a',
          'pcm_s16le',
          wavPath,
          '-y'
        ])
        ProcessManager.register(proc, 'asr-ffmpeg')
        proc.on('close', (code: number) => {
          code !== 0 ? reject(new Error(`FFmpeg退出码: ${code}`)) : resolve()
        })
      })

      // Whisper 推理
      const stdout = await new Promise<string>((resolve, reject) => {
        let output = ''
        const proc = spawn(whisperExe, ['-m', modelPath, '-f', wavPath, '-l', 'zh'])
        ProcessManager.register(proc, 'asr-whisper')
        proc.stdout.on('data', (data: Buffer) => {
          output += data.toString()
        })
        proc.on('close', (code: number) => {
          code !== 0 ? reject(new Error(`Whisper退出码: ${code}`)) : resolve(output)
        })
      })

      // 清理临时文件
      if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath)

      // 解析时间戳
      const lines = stdout.split('\n')
      const resultLines: string[] = []
      for (const line of lines) {
        const match = line.match(/\[(\d{2}:\d{2}:\d{2})\.\d{3}\s*-->.*\]\s*(.*)/)
        if (match && match[2].trim() && !match[2].trim().startsWith('[')) {
          resultLines.push(`[${match[1]}] ${match[2].trim()}`)
        }
      }

      AppLogger.info(LOG_TAGS.AI_ENGINE, `[ASREngine] 识别 ${resultLines.length} 行语音文本`)
      return resultLines.length > 0 ? resultLines.join('\n') : ENGINE_STATUS.NO_LINES_DETECTED
    } catch (err: any) {
      return `异常: ${err.message}`
    }
  }
}
