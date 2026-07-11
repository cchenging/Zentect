// 路径：src/main/engine/strategies/SemanticFlowStrategy.ts
// 语义流生成策略：通过 Vision LLM 生成时序语义描述，迁移自旧版 ExtractionPipeline

import { BaseNodeStrategy, ExecutionContext } from './BaseNodeStrategy';
import { VisionProcessor } from '../media/VisionProcessor';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '../../../modules/infra/logger/LogConstants';

export class SemanticFlowStrategy extends BaseNodeStrategy {
  readonly nodeType = 'semantic-flow';
  readonly isRecoverable = true;

  protected async performTask(
    _input: any,
    context: ExecutionContext,
    _cacheDir: string,
    onProgress: (p: number, s: string) => void
  ): Promise<any> {
    // 从 context.bus 获取上游组装的镜头数据
    let shots: any[] = [];
    try {
      shots = context.bus.get('assembled-shots') || context.bus.get('step1-shots') || [];
    } catch {
      // bus 读取失败继续
    }

    if (shots.length === 0) {
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[SemanticFlow] 无镜头数据，跳过语义流生成');
      context.bus.set('semantic-flow-result', []);
      return [];
    }

    onProgress(10, `正在生成时序语义流 (${shots.length} 个镜头)...`);

    try {
      const shotsWithSemantic = await VisionProcessor.generateSemanticFlow(shots);
      context.bus.set('semantic-flow-result', shotsWithSemantic);

      onProgress(100, '语义流生成完成');
      AppLogger.info(LOG_TAGS.MEDIA_ENGINE,
        `[SemanticFlow] 生成完成: ${shotsWithSemantic.length} 个镜头已注入语义描述`);

      return shotsWithSemantic;
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
        `[SemanticFlow] 语义流生成失败，降级跳过: ${e.message}`);
      context.bus.set('semantic-flow-result', shots);
      return shots;
    }
  }
}
