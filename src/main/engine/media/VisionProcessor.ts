// 📁 路径：src/main/engine/media/VisionProcessor.ts
import path from 'path';
import fs from 'fs';
import { ProcessManager } from '../../utils/processManager';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '../../../modules/infra/logger/LogConstants';
import { AIDaemon } from '../../core/AIDaemon';
import { HttpClient } from '../../core/HttpClient';

export class VisionProcessor {
  /**
   * 极速抽取关键帧，供视觉大模型 (VLM) 分析
   * @param mode 'fps' 按秒抽帧 | 'scene' 按转场镜头抽帧
   */
  public static async extractKeyframes(
    inputVideoPath: string,
    outputDir: string,
    mode: 'fps' | 'scene' = 'fps',
    value: number = 1,
    onProgress?: (p: number, msg: string) => void
  ): Promise<string[]> {
    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[VisionProcessor] Extracting frames from ${inputVideoPath} (Mode: ${mode})`);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputPattern = path.join(outputDir, 'frame_%04d.jpg');
    let vfFilter = `fps=${value},scale=640:-1`;

    if (mode === 'scene') {
      vfFilter = `select='gt(scene,${value})',showinfo,scale=640:-1`;
    }

    const args = [
      '-y',
      '-i', inputVideoPath,
      '-vf', vfFilter,
      // P1: fps 模式使用 cfr 保证输出帧率精确；P2: q:v 统一为 3
      '-vsync', mode === 'fps' ? 'cfr' : 'vfr',
      '-q:v', '3',
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

    const files = fs.readdirSync(outputDir)
      .filter(f => f.endsWith('.jpg'))
      .sort()
      .map(f => path.join(outputDir, f));

    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[VisionProcessor] Extracted ${files.length} frames.`);
    return files;
  }

  /**
   * 人脸扫描：调用 AIDaemon 视觉服务检测帧中的人脸
   * 支持分批送入，避免超长帧列表导致 HTTP 超时
   * @param frames 帧图片路径列表
   * @param facesDir 人脸输出目录
   * @returns 检测到的人脸角色列表
   */
  public static async scanFaces(frames: string[], facesDir: string): Promise<any[]> {
    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[VisionProcessor] scanFaces: scanning ${frames.length} frames`);

    if (!frames || frames.length === 0) {
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[VisionProcessor] scanFaces: no frames provided, returning empty');
      return [];
    }

    if (!fs.existsSync(facesDir)) {
      fs.mkdirSync(facesDir, { recursive: true });
    }

    try {
      const pythonPort = AIDaemon.getInstance?.().getPort?.() || 9885;
      const BATCH_SIZE = 100; // 每批最多 100 帧，避免 HTTP 请求过大
      const allFaces: any[] = [];

      /** 分批送入人脸检测 */
      for (let i = 0; i < frames.length; i += BATCH_SIZE) {
        const batch = frames.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(frames.length / BATCH_SIZE);

        AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[VisionProcessor] scanFaces: 批次 ${batchNum}/${totalBatches} (${batch.length} 帧)`);

        try {
          const response = await HttpClient.post(`http://127.0.0.1:${pythonPort}/face/detect`, {
            frames: batch
          });
          const batchFaces = response?.data?.faces || [];
          allFaces.push(...batchFaces);
        } catch (batchErr: any) {
          AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[VisionProcessor] scanFaces 批次 ${batchNum} 失败: ${batchErr.message}`);
        }
      }

      return allFaces;
    } catch (error) {
      console.error('[VisionProcessor] 物理修复 - 人脸识别通信断裂:', error);
      return [];
    }
  }

  /**
   * 人脸聚类：将检测到的人脸按特征聚类为角色
   * @param mediaId 媒体ID
   * @param faces 检测到的人脸列表
   * @returns 人脸到聚类ID的映射
   */
  public static async clusterFaces(mediaId: string, faces: any[]): Promise<Record<string, string>> {
    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[VisionProcessor] clusterFaces: clustering ${faces.length} faces for ${mediaId}`);

    if (!faces || faces.length === 0) {
      return {};
    }

    // 尝试调用 AIDaemon 人脸聚类服务
    try {
      const { AIDaemon } = await import('../../core/AIDaemon');
      const result = await AIDaemon.instance.request('/api/cluster_faces', {
        method: 'POST',
        body: JSON.stringify({ mediaId, faces })
      });
      if (result && result.clustersMap) {
        return result.clustersMap;
      }
      return {};
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[VisionProcessor] clusterFaces: AIDaemon unavailable, returning empty. ${e.message}`);
      return {};
    }
  }

  /**
   * CLIP 语义提取：为镜头构建高维语义索引
   * @param mediaId 媒体ID
   * @param shots 已组装的镜头列表
   * @returns 语义提取结果
   */
  public static async extractSemantics(mediaId: string, shots: any[]): Promise<any> {
    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[VisionProcessor] extractSemantics: extracting for ${shots.length} shots of ${mediaId}`);

    if (!shots || shots.length === 0) {
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[VisionProcessor] extractSemantics: no shots provided');
      return { sceneDescriptions: '', segments: [] };
    }

    // 💥【核心修复】：修正 RPC 通信函数签名，将真实数据喂给 Python 侧的 Faiss 和 CLIP
    try {
      const pythonPort = AIDaemon.getInstance?.().getPort?.() || 9885;

      const response = await HttpClient.post(`http://127.0.0.1:${pythonPort}/semantic/extract`, {
        mediaId,
        shots
      });

      return response?.data || { success: true };
    } catch (error) {
      console.warn('[VisionProcessor] 语义检索微服务不可用，自愈降级:', error);
      return { success: false, error: 'AI 服务未就绪' };
    }
  }

  /**
   * 语义流生成：通过 Vision LLM 生成时序语义描述
   * @param shots 已组装的镜头列表
   * @returns 注入了 semanticDescription 的镜头列表
   */
  public static async generateSemanticFlow(shots: any[]): Promise<any[]> {
    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[VisionProcessor] generateSemanticFlow: generating for ${shots.length} shots`);

    if (!shots || shots.length === 0) {
      return shots || [];
    }

    // 尝试调用 LLM 生成语义流
    try {
      const { LLMFactory } = await import('../adapters/LLMFactory');
      const adapter = LLMFactory.create('visual');
      const frameDescriptions = shots.map((s: any, i: number) =>
        `镜头${i + 1}: ${s.visionText || s.originalText || '无描述'}`
      ).join('\n');

      const prompt = `请根据以下镜头描述，生成连贯的时序语义流分析：\n${frameDescriptions}`;
      const result = await adapter.chat([{ role: 'user', content: prompt }]);

      // 将语义描述注入到每个镜头中
      return shots.map((shot: any) => ({
        ...shot,
        semanticDescription: result || ''
      }));
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[VisionProcessor] generateSemanticFlow: LLM unavailable, degrading gracefully. ${e.message}`);
      return shots;
    }
  }
}
