import { BaseNodeStrategy, ExecutionContext } from './BaseNodeStrategy';
import { VisionProcessor } from '../media/VisionProcessor';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';
import * as path from 'path';
import * as fs from 'fs';

/**
 * 人脸检测节点策略（SimplePipelineRunner 路径）
 *
 * 🔧 修复审计缺陷 §2.2：
 *   旧实现把原始视频 mediaPath 当作 image_path 传给 /api/vision，
 *   Python 端 cv2.imdecode 无法解码视频文件，且未传 output_dir（Pydantic 必填）。
 *
 * 修复后流程：
 *   1. 从 context.bus 读取上游 extract_frames 节点产出的 framePaths
 *   2. 调用 VisionProcessor.scanFaces(frames, facesDir, signal) 分批检测
 *   3. 调用 VisionProcessor.clusterFaces(mediaId, faces, facesDir) 聚类
 *   4. 按 cluster 反向分组为 roles，供下游节点消费
 *
 * 与 Step1MaterialStrategy 路径保持一致，仅用于 SimplePipelineRunner 线性管线。
 */
export class FaceDetectStrategy extends BaseNodeStrategy {
  readonly nodeType = 'face-detect';
  /** 人脸检测失败时降级跳过，不阻断后续步骤 */
  readonly isRecoverable = true;

  protected async performTask(
    task: any,
    context: ExecutionContext,
    cacheDir: string,
    onProgress: (p: number, s: string) => void
  ): Promise<any> {
    /** BaseNodeStrategy 将 params 和 mergedInputs 合并为扁平对象，直接从顶层取值 */
    const mediaId: string = task.mediaId;
    if (!mediaId) throw new Error('人物识别失败：未找到 mediaId');

    // 步骤1：从 bus 取抽帧步骤产出的 framePaths
    //   bus key 约定 = nodeId = `${projectId}_${mediaId}_extract_frames`
    //   value 为 VisionExtractOutput，含 framePaths 字段
    const extractFramesKey = `${context.projectId}_${mediaId}_extract_frames`;
    const extractResult = context.bus.get(extractFramesKey);
    const frames: string[] = extractResult?.framePaths || [];

    if (frames.length === 0) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[FaceDetect] 抽帧结果为空 (bus key=${extractFramesKey})，跳过人脸检测`);
      return { faces: [], faceCount: 0, clusters: {}, roles: [], _skipped: true };
    }

    // 步骤2：构造人脸输出目录（复用 nodeCacheDir 下的 faces 子目录）
    const facesDir = path.join(cacheDir, 'faces');
    if (!fs.existsSync(facesDir)) fs.mkdirSync(facesDir, { recursive: true });

    // 步骤3：分批调用 /api/vision 检测人脸（VisionProcessor 内部按 100 帧一批）
    onProgress(30, `正在扫描 ${frames.length} 帧中的人脸...`);
    const faces = await VisionProcessor.scanFaces(frames, facesDir, context.signal);

    if (faces.length === 0) {
      onProgress(100, '未检测到人脸');
      return { faces: [], faceCount: 0, clusters: {}, roles: [] };
    }

    // 步骤4：HDBSCAN 聚类为角色
    onProgress(70, `检测到 ${faces.length} 张人脸，正在聚类...`);
    const clustersMap = await VisionProcessor.clusterFaces(mediaId, faces, facesDir);

    // 步骤5：按 cluster 反向分组为 roles 结构（与 Step1MaterialStrategy 对齐）
    const roleGroups: Record<string, string[]> = {};
    for (const [faceId, clusterId] of Object.entries(clustersMap)) {
      if (!roleGroups[clusterId]) roleGroups[clusterId] = [];
      roleGroups[clusterId].push(faceId);
    }
    const roles = Object.keys(roleGroups).map(clusterId => ({
      id: `${mediaId}_${clusterId}`,
      name: `角色_${clusterId}`,
      faceCount: roleGroups[clusterId].length,
      /** 修复黑头像：representative 包含 facePath，供 PipelineResultWriter 读取 avatar */
      representative: (() => {
        const firstFace = roleGroups[clusterId]
          .map(fid => faces.find(f => (f.id || f.face_id) === fid))
          .filter(Boolean)[0];
        return firstFace ? { ...firstFace, facePath: firstFace.face_path || firstFace.facePath || '' } : null;
      })(),
      faces: roleGroups[clusterId]
        .map(fid => faces.find(f => (f.id || f.face_id) === fid))
        .filter(Boolean),
    }));

    onProgress(100, `人脸扫描完成，识别 ${roles.length} 个角色`);
    return { faces, faceCount: faces.length, clusters: clustersMap, roles };
  }
}
