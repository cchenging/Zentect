import type { EditorNode, PipelineTask } from '../../../../shared/types';
import type { INodeParser } from './types';

export class ScriptGenParser implements INodeParser {
  parse(node: EditorNode, upstreamContext: Record<string, any>): PipelineTask | null {
    return {
      nodeId: node.id,
      actionType: 'script-gen',
      label: node.data?.label || '智能剧本重铸',
      params: {
        llmEngine: node.data?.params?.llmEngine ?? 'openai',
        targetLanguage: node.data?.params?.targetLanguage ?? 'zh',
        scriptStyle: node.data?.params?.scriptStyle ?? 'professional',
        temperature: node.data?.params?.temperature ?? 0.7,
        customPrompt: node.data?.params?.customPrompt || '',
        framesDir: upstreamContext.framesDir,
        textData: upstreamContext.textData,
      },
      dependsOn: upstreamContext.dependsOn || [],
      mergedInputs: {
        framesDir: upstreamContext.framesDir,
        textData: upstreamContext.textData,
      },
    };
  }
}