import type { INodeParser } from './types';
import type { PipelineTask } from '../../../../shared/types';

export class LLMProcessorParser implements INodeParser {
  parse(node: any, upstreamContext: Record<string, any>): PipelineTask | null {
    return {
      nodeId: node.id,
      actionType: 'llm-processor',
      label: node.data?.label || 'LLM 处理',
      params: {
        model: node.data?.params?.model || '',
        systemPrompt: node.data?.params?.systemPrompt || '',
        temperature: node.data?.params?.temperature ?? 0.7,
        inputMapping: node.data?.params?.inputMapping || '',
      },
      dependsOn: upstreamContext?.dependsOn || [],
      mergedInputs: upstreamContext,
    };
  }
}
