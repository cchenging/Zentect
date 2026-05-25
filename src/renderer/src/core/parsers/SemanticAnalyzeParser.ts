import type { INodeParser } from './types';
import type { PipelineTask } from '../../../../shared/types';

export class SemanticAnalyzeParser implements INodeParser {
  parse(node: any, upstreamContext: Record<string, any>): PipelineTask | null {
    return {
      nodeId: node.id,
      actionType: 'semantic-analyze',
      label: node.data?.label || '视觉语义',
      params: {
        ...node.data?.params,
      },
      dependsOn: upstreamContext?.dependsOn || [],
      mergedInputs: upstreamContext,
    };
  }
}
