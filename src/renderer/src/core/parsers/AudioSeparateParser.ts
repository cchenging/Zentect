import type { PipelineTask } from '../../../../shared/types';
import type { PipelineNodeRef } from './types';
import { INodeParser } from './types';

export class AudioSeparateParser implements INodeParser {
  parse(node: PipelineNodeRef, upstreamContext: Record<string, any>): PipelineTask | null {
    const mediaPath = upstreamContext.mediaPath;
    if (!mediaPath) {
      console.warn(`[AudioSeparateParser] 节点 ${node.id} 缺少上游媒体源`);
      return null;
    }

    return {
      nodeId: node.id,
      actionType: 'audio-separate',
      label: node.data?.label || '音频分离',
      params: {
        model: node.data?.params?.model ?? 'demucs',
        stems: node.data?.params?.stems ?? ['vocals', 'bgm'],
      },
      dependsOn: upstreamContext.dependsOn || [],
      mergedInputs: {
        mediaPath,
      },
    };
  }
}