import type { PipelineTask } from '../../../../shared/types';

export interface PipelineNodeRef {
  id: string;
  type: string;
  data: {
    actionType?: string;
    label?: string;
    status?: string;
    progress?: number;
    [key: string]: unknown;
  };
}

export interface INodeParser {
  parse(node: PipelineNodeRef, upstreamContext: Record<string, any>): PipelineTask | null;
}