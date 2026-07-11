// 路径：src/main/engine/strategies/ClusterFacesStrategy.ts
// 人脸聚类策略：HDBSCAN 聚类 + 角色归纳，迁移自旧版 ExtractionPipeline

import { BaseNodeStrategy, ExecutionContext } from './BaseNodeStrategy';
import { VisionProcessor } from '../media/VisionProcessor';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '../../../modules/infra/logger/LogConstants';

export class ClusterFacesStrategy extends BaseNodeStrategy {
  readonly nodeType = 'cluster-faces';
  readonly isRecoverable = true;

  protected async performTask(
    input: any,
    context: ExecutionContext,
    _cacheDir: string,
    onProgress: (p: number, s: string) => void
  ): Promise<any> {
    const mediaId = input.mediaId || context.projectId || 'unknown';

    // 从 context.bus 获取上游人脸检测结果
    let faces: any[] = [];
    try {
      const step1Result = context.bus.get('step1-result');
      if (step1Result?.faces?.roles) {
        faces = step1Result.faces.roles;
      }
    } catch {
      // bus 读取失败继续
    }

    // 也检查 face-detect 策略写入的结果
    if (faces.length === 0) {
      try {
        const faceDetectResult = context.bus.get('face-detect-result');
        if (faceDetectResult?.faces) {
          faces = faceDetectResult.faces;
        }
      } catch {
        // bus 读取失败继续
      }
    }

    if (faces.length === 0) {
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[ClusterFaces] 无人脸数据，跳过聚类');
      context.bus.set('cluster-faces-result', { clusters: {}, clustersMap: {}, roles: [] });
      return { clusters: {}, clustersMap: {}, roles: [] };
    }

    onProgress(10, `正在对人脸特征聚类 (${faces.length} 个)...`);

    try {
      const clustersMap = await VisionProcessor.clusterFaces(mediaId, faces);

      // 将聚类 ID 注入到每张人脸
      const roles: Array<{ faceId: string; clusterId: string }> = [];
      for (const face of faces) {
        const faceId = face.faceId || face.id || face.path || '';
        roles.push({
          faceId,
          clusterId: clustersMap[faceId] || 'unclustered',
        });
      }

      const result = {
        clusters: this.buildClusters(roles),
        clustersMap,
        roles,
      };

      context.bus.set('cluster-faces-result', result);
      onProgress(100, `人脸聚类完成 (${Object.keys(clustersMap).length} 个映射)`);
      AppLogger.info(LOG_TAGS.MEDIA_ENGINE,
        `[ClusterFaces] 聚类完成: ${Object.keys(clustersMap).length} 个聚类映射`);

      return result;
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
        `[ClusterFaces] 聚类失败，降级跳过: ${e.message}`);
      context.bus.set('cluster-faces-result', { clusters: {}, clustersMap: {}, roles: [] });
      return { clusters: {}, clustersMap: {}, roles: [] };
    }
  }

  /** 将 clusterMap 反转为 clusterId → faceId[] 结构 */
  private buildClusters(
    roles: Array<{ faceId: string; clusterId: string }>
  ): Record<string, string[]> {
    const acc: Record<string, Set<string>> = {};
    for (const r of roles) {
      if (!acc[r.clusterId]) acc[r.clusterId] = new Set();
      acc[r.clusterId].add(r.faceId);
    }
    const out: Record<string, string[]> = {};
    for (const [cid, ids] of Object.entries(acc)) {
      out[cid] = [...ids];
    }
    return out;
  }
}
