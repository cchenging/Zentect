import type { PipelineTask } from '../../../../shared/types';
import type { PipelineNodeRef } from './types';
import type { INodeParser } from './types';

export class ScriptGenParser implements INodeParser {
  parse(node: PipelineNodeRef, upstreamContext: Record<string, any>): PipelineTask | null {
    // 🔧 node.data.params 的索引签名是 unknown，先收窄为 Record 再读取可选配置
    const params = (node.data?.params ?? {}) as Record<string, any>;

    return {
      nodeId: node.id,
      actionType: 'script-gen',
      label: node.data?.label || '智能剧本重铸',
      params: {
        llmEngine: params.llmEngine ?? 'openai',
        targetLanguage: params.targetLanguage ?? 'zh',
        scriptStyle: params.scriptStyle ?? 'professional',
        temperature: params.temperature ?? 0.7,
        customPrompt: params.customPrompt || '',
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