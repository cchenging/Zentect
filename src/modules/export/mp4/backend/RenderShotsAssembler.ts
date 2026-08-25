// 📁 路径：src/modules/export/mp4/backend/RenderShotsAssembler.ts
// 渲染镜头装配：将 ExportProject.shots 装配为 FFmpegRenderer.RenderShot[]
//
// 职责：只负责「镜头 → 渲染镜头」的转换，不涉及渲染参数 / 分辨率 / 帧率。
// 🎬 阶段 A：同一 sceneGroupId 的连续兄弟段合并为单个渲染镜头（单个 FFmpeg 截取区间），
// 从物理上消除同镜头兄弟段被导出层当独立镜头硬切产生的假转场接缝。
// 源区间 = 组首源起点 ~ 组尾源终点；变速因子按「源总时长 / 目标总时长」整体换算；
// 组内其余兄弟段的配音以相对偏移 ttsAudioTracks 保留（视频合并、配音逐句）。

import type { ExportProject, ExportShot } from '../../contracts/ExportProject';
import type { RenderShot } from '../../../../main/engine/media/FFmpegRenderer';

/**
 * 将单个镜头映射为渲染镜头（不合并）。
 *
 * @param shot 装配好的中间数据模型中的单个镜头
 * @returns 渲染镜头
 */
function mapOne(shot: ExportShot): RenderShot {
  return {
    id: shot.id,
    startTime: shot.start,
    endTime: shot.end,
    ttsAudioPath: shot.audioPath,
    chunkData: (shot.chunkData as any) || null,
    speedFactor: shot.appliedSpeedFactor,
  };
}

/**
 * 将 ExportProject.shots 装配为 FFmpegRenderer.RenderShot[]。
 *
 * 每个镜头映射：起止时间（秒）、配音路径、切片数据、变速因子。
 * 同一 sceneGroupId 的连续镜头合并为一个 RenderShot，消除物理接缝。
 *
 * @param project 装配好的中间数据模型
 * @returns 渲染镜头数组
 */
export function assembleRenderShots(project: ExportProject): RenderShot[] {
  const shots = project.shots;
  const result: RenderShot[] = [];
  let i = 0;

  while (i < shots.length) {
    const lead = shots[i];
    const groupId = lead.sceneGroupId;

    // 未标记分组的镜头：单段直通
    if (!groupId) {
      result.push(mapOne(lead));
      i++;
      continue;
    }

    // 收集连续的同组兄弟段（sceneGroupId 相同才合并，物理镜头天然连续）
    const members = [lead];
    let j = i + 1;
    while (j < shots.length && shots[j].sceneGroupId === groupId) {
      members.push(shots[j]);
      j++;
    }

    if (members.length === 1) {
      result.push(mapOne(lead));
      i = j;
      continue;
    }

    const first = members[0];
    const last = members[members.length - 1];

    // ExportShot.start/end 已由装配器统一为【源视频坐标】（秒），源区间取组首~组尾源坐标（毫秒）。
    // 不读 chunkData.startMs/endMs：那是 body 切片内坐标，与源视频变速因子计算不同系（缺陷 D1 同源）。
    const srcStartMs = first.start * 1000;
    const srcEndMs = last.end * 1000;

    // 目标时长 = 组内成员 target 时长之和（时间线上连续，= last.end - first.start）
    const targetDurSec = last.end - first.start;
    const srcDurSec = (srcEndMs - srcStartMs) / 1000;
    // 变速因子按「源总时长 / 目标总时长」整体换算（与单段 appliedSpeedFactor 语义一致）
    const speedFactor = targetDurSec > 0 && srcDurSec > 0 ? srcDurSec / targetDurSec : first.appliedSpeedFactor || 1.0;

    // 组内其余兄弟段的配音：相对镜头时间线起点偏移（视频合并、配音逐句保留）
    const subTts = members.slice(1)
      .filter((m) => m.audioPath)
      .map((m) => ({ path: m.audioPath!, offsetSec: m.start - first.start }));

    const merged: RenderShot = {
      id: first.id,
      startTime: first.start,
      endTime: last.end,
      ttsAudioPath: first.audioPath,
      chunkData: first.chunkData
        ? {
            ...(first.chunkData as Record<string, unknown>),
            // 合并后切片素材沿用组首切片（body 切片 + body 坐标）；startMs/endMs 记录源区间（源坐标）
            filePath: (first.chunkData as { filePath?: string } | undefined)?.filePath ?? '',
            startMs: srcStartMs,
            endMs: srcEndMs,
            durationMs: srcEndMs - srcStartMs,
          } as RenderShot['chunkData']
        : null,
      speedFactor,
    };
    if (subTts.length > 0) {
      merged.ttsAudioTracks = subTts;
    }

    result.push(merged);
    i = j;
  }

  return result;
}
