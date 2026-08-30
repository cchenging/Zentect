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
    onProgress(5, `正在扫描 ${frames.length} 帧中的人脸...`);
    const faces = await VisionProcessor.scanFaces(frames, facesDir, context.signal);

    if (faces.length === 0) {
      onProgress(100, '未检测到人脸');
      return { faces: [], faceCount: 0, clusters: {}, roles: [] };
    }

    // 步骤4：HDBSCAN 聚类为角色
    onProgress(40, `检测到 ${faces.length} 张人脸，正在聚类...`);
    const clustersMap = await VisionProcessor.clusterFaces(mediaId, faces, facesDir);

    // 步骤5：按 cluster 反向分组为 roles 结构（与 Step1MaterialStrategy 对齐）
    const roleGroups: Record<string, string[]> = {};
    for (const [faceId, clusterId] of Object.entries(clustersMap)) {
      if (!roleGroups[clusterId]) roleGroups[clusterId] = [];
      roleGroups[clusterId].push(faceId);
    }
    const rawRoles = Object.keys(roleGroups).map(clusterId => {
      const clusterFaces = roleGroups[clusterId]
        .map(fid => faces.find(f => (f.id || f.face_id) === fid))
        .filter(Boolean);
      /** 修复黑头像 + 小头像：用「最佳代表脸」作为头像
       * 旧版取第一张脸（可能是远景小脸），新版选 bbox 面积最大且清晰的代表脸 */
      const bestFace = VisionProcessor.pickRepresentativeFace(clusterFaces) || clusterFaces[0] || null;
      const facePath = bestFace ? (bestFace.face_path || bestFace.facePath || '') : '';
      return {
        id: `${mediaId}_${clusterId}`,
        name: `角色_${clusterId}`,
        faceCount: clusterFaces.length,
        /** 修复黑头像：representative 包含 facePath，供 PipelineResultWriter 读取 avatar */
        representative: bestFace ? { ...bestFace, facePath } : null,
        /** avatarPath 供前端显示头像 */
        avatarPath: facePath,
        faces: clusterFaces,
      };
    });

    // 步骤6：角色主次分级（频次规则 → main/extra，兜底最高频保留1个主角）
    //   supporting 配角留给用户前端手动标注（TierBadge 三档循环切换）
    const roles = FaceDetectStrategy.computeRoleTierByFrequency(rawRoles);
    const mainCount = roles.filter((r) => r.tier === 'main').length;
    const extraCount = roles.filter((r) => r.tier === 'extra').length;

    onProgress(100, `人脸扫描完成，识别 ${roles.length} 个角色（主角 ${mainCount} / 路人 ${extraCount}）`);
    return { faces, faceCount: faces.length, clusters: clustersMap, roles };
  }

  /**
   * 角色主次分级：根据 faceCount（人脸聚类后出现频次）自动分配 tier 字段
   *
   * 规则（用户明确规定，唯一真源，禁止擅自变更）：
   *   1. 频次 ≥ 3 → tier = 'main'（主角）
   *   2. 频次 < 3 → tier = 'extra'（背景路人）
   *      ⚠️  supporting 配角不自动分配，留给前端 TierBadge 三档循环手动标注
   *   3. 兜底：若全员 < 3（或全是非法 count 导致全员 0）
   *      → 取规范化 faceCount 最高且数组位置最前的 1 个，强制升为 'main'
   *        （保证全片至少有 1 个主角，避免 UI 全是路人尴尬）
   *   4. 非法 faceCount（null/undefined/NaN/负数/非数字）→ 规范化为 0（错就错不兜底）
   *
   * 纯函数特性：
   *   - 入参 null/undefined → 返回 []，永不抛错
   *   - 不修改原 role 对象（不可变展开），返回全新数组
   *   - 输出稳定可重复（不引入随机，并列最高频时取数组第一个）
   *
   * @param roles 任意类型角色数组（要求含 id + faceCount 可选字段）
   * @returns 注入 tier 后的新角色数组（原对象不被改写）
   */
  public static computeRoleTierByFrequency<T extends { id: string; faceCount?: number | null }>(
    roles: T[] | null | undefined
  ): Array<T & { tier: 'main' | 'supporting' | 'extra' }> {
    if (!Array.isArray(roles) || roles.length === 0) return [];

    // 规范化 faceCount：非数字 / NaN / < 0 → 0；浮点向下取整（避免半张脸凑数）
    const normalizedCounts = roles.map((r) => {
      const raw = r?.faceCount;
      if (typeof raw !== 'number' || Number.isNaN(raw) || raw < 0) return 0;
      return Math.floor(raw);
    });

    // 初筛分级：≥3 → main，其余 → extra
    const prelim = roles.map((role, idx) => ({
      ...(role as object),
      tier: (normalizedCounts[idx] >= 3 ? 'main' : 'extra') as 'main' | 'extra',
    })) as Array<T & { tier: 'main' | 'supporting' | 'extra' }>;

    // 兜底：若没有 main，则强制最高频（数组首位优先）的第 1 个升为 main
    const hasAnyMain = prelim.some((r) => r.tier === 'main');
    if (!hasAnyMain) {
      let maxIdx = 0;
      let maxVal = normalizedCounts[0];
      for (let i = 1; i < normalizedCounts.length; i++) {
        if (normalizedCounts[i] > maxVal) {
          maxVal = normalizedCounts[i];
          maxIdx = i;
        }
      }
      prelim[maxIdx] = { ...(prelim[maxIdx] as object), tier: 'main' } as T & { tier: 'main' | 'supporting' | 'extra' };
    }

    return prelim;
  }
}
