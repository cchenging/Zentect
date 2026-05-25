// 📁 路径：src/main/engine/media/VisionProcessor.ts
import path from 'path';
import fs from 'fs';
import { ProcessManager } from '../../utils/processManager';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '../../../shared/utils/LogConstants';

export class VisionProcessor {
  /**
   * 💥 核心动作：极速抽取关键帧，供视觉大模型 (VLM) 分析
   * @param mode 'fps' 按秒抽帧 | 'scene' 按转场镜头抽帧
   */
  public static async extractKeyframes(
    inputVideoPath: string,
    outputDir: string,
    mode: 'fps' | 'scene' = 'fps',
    value: number = 1, // 如果是 fps 模式，1 代表每秒1帧
    onProgress?: (p: number, msg: string) => void
  ): Promise<string[]> {
    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[VisionProcessor] Extracting frames from ${inputVideoPath} (Mode: ${mode})`);
    
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputPattern = path.join(outputDir, 'frame_%04d.jpg');
    let vfFilter = `fps=${value}`;
    
    if (mode === 'scene') {
      // 场景检测算法：利用 FFmpeg 的 select 滤镜，提取画面变化超过阈值(如0.3)的帧
      vfFilter = `select='gt(scene,${value})',showinfo`;
    }

    const args = [
      '-y',
      '-i', inputVideoPath,
      '-vf', vfFilter,
      '-vsync', 'vfr', // 可变帧率输出
      '-q:v', '2',     // 高质量 JPEG
      outputPattern
    ];

    await ProcessManager.spawnSafe({
      command: 'ffmpeg',
      args,
      totalDurationRegex: /Duration: (\d{2}:\d{2}:\d{2}\.\d{2})/,
      progressRegex: /time=(\d{2}:\d{2}:\d{2}\.\d{2})/,
      onProgress: (p, msg) => {
        if (onProgress) onProgress(p, `抽取画面帧: ${msg}`);
      }
    });

    // 收集生成的图片路径并按时间排序
    const files = fs.readdirSync(outputDir)
      .filter(f => f.endsWith('.jpg'))
      .sort()
      .map(f => path.join(outputDir, f));

    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[VisionProcessor] Extracted ${files.length} frames.`);
    return files;
  }
}
