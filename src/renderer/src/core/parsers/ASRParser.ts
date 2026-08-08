import type { PipelineTask } from '../../../../shared/types';
import type { PipelineNodeRef } from './types';
import type { INodeParser } from './types';

export class ASRParser implements INodeParser {
  parse(node: PipelineNodeRef, upstreamContext: Record<string, any>): PipelineTask | null {
    const mediaPath = upstreamContext.vocalPath || upstreamContext.mediaPath;
    if (!mediaPath) {
      console.warn(`[ASRParser] 节点 ${node.id} 缺少上游音频源`);
      return null;
    }

    // 🔧 node.data.params 的索引签名是 unknown，先收窄为 Record 再读取可选配置
    const params = (node.data?.params ?? {}) as Record<string, any>;

    return {
      nodeId: node.id,
      actionType: 'asr',
      label: node.data?.label || '台词识别',
      params: {
        engine: params.engine ?? 'whisper',
        language: params.language ?? 'zh',
      },
      dependsOn: upstreamContext.dependsOn || [],
      mergedInputs: {
        audioPath: mediaPath,
      },
    };
  }
}