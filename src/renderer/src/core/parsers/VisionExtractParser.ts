import type { PipelineTask } from '../../../../shared/types';
import type { PipelineNodeRef } from './types';
import type { INodeParser } from './types';

export class VisionExtractParser implements INodeParser {
  parse(node: PipelineNodeRef, upstreamContext: Record<string, any>): PipelineTask | null {
    const mediaPath = upstreamContext.mediaPath;
    if (!mediaPath) {
      console.warn(`[VisionExtractParser] 节点 ${node.id} 缺少上游媒体源`);
      return null;
    }

    // 🔧 node.data.params 的索引签名是 unknown，先收窄为 Record 再读取可选配置
    const params = (node.data?.params ?? {}) as Record<string, any>;

    return {
      nodeId: node.id,
      actionType: 'vision-extract',
      label: node.data?.label || '视觉抽帧',
      params: {
        fps: params.fps ?? 1,
        threshold: params.threshold ?? 0,
        strategy: params.strategy ?? 'scene',
      },
      dependsOn: upstreamContext.dependsOn || [],
      mergedInputs: {
        mediaPath,
        mediaWidth: upstreamContext.mediaWidth,
        mediaHeight: upstreamContext.mediaHeight,
        mediaFps: upstreamContext.mediaFps,
      },
    };
  }
}