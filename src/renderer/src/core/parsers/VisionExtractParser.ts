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

    return {
      nodeId: node.id,
      actionType: 'vision-extract',
      label: node.data?.label || '视觉抽帧',
      params: {
        fps: node.data?.params?.fps ?? 1,
        threshold: node.data?.params?.threshold ?? 0,
        strategy: node.data?.params?.strategy ?? 'scene',
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