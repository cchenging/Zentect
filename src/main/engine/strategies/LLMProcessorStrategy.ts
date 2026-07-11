import { BaseNodeStrategy, ExecutionContext } from './BaseNodeStrategy';
import { PipelineTask } from '../../../shared/types';
import { LLMFactory } from '../adapters/LLMFactory';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '../../../modules/infra/logger/LogConstants';

export class LLMProcessorStrategy extends BaseNodeStrategy {
  readonly nodeType = 'llm-processor';

  protected async performTask(
    task: PipelineTask,
    context: ExecutionContext,
    _cacheDir: string,
    onProgress: (p: number, s: string) => void
  ): Promise<any> {
    const model = task.params?.model || context.modelConfig?.modelName || 'deepseek-chat';
    const provider = context.modelConfig?.provider || 'deepseek';
    const baseUrl = context.modelConfig?.customBaseUrl;
    const systemPrompt = task.params?.systemPrompt || '你是一个有用的AI助手';
    const temperature = task.params?.temperature ?? 0.7;

    const upstreamContent = Object.entries(task.mergedInputs || {})
      .filter(([k]) => !['dependsOn', 'mediaPath', 'mediaId'].includes(k))
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v).slice(0, 500)}`)
      .join('\n');

    const userPrompt = task.params?.inputMapping || '请根据以上数据进行分析处理。';

    onProgress(20, `正在呼叫 ${model} 模型...`);

    try {
      const adapter = LLMFactory.create(provider as any, '', baseUrl || '');
      const response = await adapter.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `上游数据:\n${upstreamContent}\n\n${userPrompt}` },
      ], 'llm-model', temperature);

      onProgress(100, 'LLM 处理完成');
      return {
        outputText: response.text || '',
        model,
        temperature,
      };
    } catch (e: any) {
      AppLogger.error(LOG_TAGS.AI_AGENT, 'LLM Processor 调用失败', e);
      throw new Error(`LLM 处理异常: ${e.message}`);
    }
  }
}
