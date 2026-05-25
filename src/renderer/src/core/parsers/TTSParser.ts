import type { INodeParser } from './types';
import type { PipelineTask } from '../../../../shared/types';

export class TTSParser implements INodeParser {
  parse(node: any, upstreamContext: Record<string, any>): PipelineTask | null {
    return {
      nodeId: node.id,
      actionType: 'tts-synthesize',
      label: node.data?.label || '语音合成',
      params: {
        voiceType: node.data?.params?.voiceType || 'default',
        speed: node.data?.params?.speed || 1.0,
        text: node.data?.params?.customText || '',
      },
      dependsOn: upstreamContext?.dependsOn || [],
      mergedInputs: upstreamContext,
    };
  }
}
