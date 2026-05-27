export interface PipelineRouteEntry {
  adapter: string;
  /** active = 当前全部新请求走此适配器 */
  active: boolean;
  /** acceptable = 兼容（绞杀者迁移期间仍接受） */
  acceptable: boolean;
  deprecated: boolean;
  description: string;
}

export const PIPELINE_ROUTES: Record<string, PipelineRouteEntry> = {
  'fixed-v1': {
    adapter: 'SimplePipelineRunner',
    active: true,
    acceptable: true,
    deprecated: false,
    description: 'V1.0 QuickCard 固定 7 步管线 — 唯一 active adapter',
  },
  'dag-v1': {
    adapter: 'PipelineEngine',
    active: true,
    acceptable: true,
    deprecated: false,
    description: 'V1.1+ DAG 引擎（专业模式）',
  },
  'compat-extraction': {
    adapter: 'ExtractionPipeline',
    active: false,
    acceptable: true,
    deprecated: true,
    description: '遗留 ExtractionPipeline — 绞杀者迁移中，新功能不得写入',
  },
} as const;

export function getActivePipelineRoute(): PipelineRouteEntry {
  for (const route of Object.values(PIPELINE_ROUTES)) {
    if (route.active) return route;
  }
  return PIPELINE_ROUTES['fixed-v1'];
}

export function getPipelineRoute(id: string): PipelineRouteEntry | undefined {
  return PIPELINE_ROUTES[id];
}
