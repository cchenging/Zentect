import type { EditorNode, PipelineTask } from '../../../../shared/types';

export interface INodeParser {
  /**
   * 将画布节点编译为后端执行任务
   */
  parse(node: EditorNode, upstreamContext: Record<string, any>): PipelineTask | null;
}