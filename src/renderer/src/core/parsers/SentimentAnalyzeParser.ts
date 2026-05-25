import type { INodeParser } from './types';
import type { PipelineTask } from '../../../../shared/types';

export class SentimentAnalyzeParser implements INodeParser {
  parse(node: any, upstreamContext: Record<string, any>): PipelineTask | null {
    return {
      nodeId: node.id,
      actionType: 'sentiment-analyze',
      label: node.data?.label || '情绪分析',
      params: {
        ...node.data?.params,
      },
      dependsOn: upstreamContext?.dependsOn || [],
      mergedInputs: upstreamContext,
    };
  }
}
