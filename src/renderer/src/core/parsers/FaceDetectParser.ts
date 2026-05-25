import type { INodeParser } from './types';
import type { PipelineTask } from '../../../../shared/types';

export class FaceDetectParser implements INodeParser {
  parse(node: any, upstreamContext: Record<string, any>): PipelineTask | null {
    return {
      nodeId: node.id,
      actionType: 'face-detect',
      label: node.data?.label || '人物识别',
      params: {
        ...node.data?.params,
      },
      dependsOn: upstreamContext?.dependsOn || [],
      mergedInputs: upstreamContext,
    };
  }
}
