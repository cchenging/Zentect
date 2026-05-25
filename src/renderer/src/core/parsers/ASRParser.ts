import type { EditorNode, PipelineTask } from '../../../../shared/types';
import type { INodeParser } from './types';

export class ASRParser implements INodeParser {
  parse(node: EditorNode, upstreamContext: Record<string, any>): PipelineTask | null {
    const mediaPath = upstreamContext.vocalPath || upstreamContext.mediaPath;
    if (!mediaPath) {
      console.warn(`[ASRParser] 节点 ${node.id} 缺少上游音频源`);
      return null;
    }

    return {
      nodeId: node.id,
      actionType: 'asr',
      label: node.data?.label || '台词识别',
      params: {
        engine: node.data?.params?.engine ?? 'whisper',
        language: node.data?.params?.language ?? 'zh',
      },
      dependsOn: upstreamContext.dependsOn || [],
      mergedInputs: {
        audioPath: mediaPath,
      },
    };
  }
}