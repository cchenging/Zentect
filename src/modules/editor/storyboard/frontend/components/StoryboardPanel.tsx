// 📁 路径: src/modules/editor/storyboard/frontend/components/StoryboardPanel.tsx
// 🎬 前端分镜单面板（编辑器左侧「分镜单」tab）。
// 展示 S2 分镜师 Agent 产出的 ShotSpec 工单（storyboard_orders.json）：
// 顶部统计条（工单总数 / 顺延 CONTINUE_PREV 占比 / 无工单空态）+ 每张工单卡片（段号/空间/主体/景别/运镜/模式/降级/备注）。
// 数据经 `window.api.storyboard.loadOrders(projectId)` 幂等拉取（缺文件/解析失败一律空，前端据此渲染空态）。

// ⚠️ 必须显式引入 React：vitest 下 .tsx 走 esbuild 经典 JSX transform（编译为 React.createElement），
//    同时用 React.* 命名空间调用 hooks，可同时兼容 web tsc 的 react-jsx 自动 runtime（避免 TS6133 unused）。
import React from 'react';

/** 拉取回来的原始工单字段（沿用 ShotSpec 契约，边村对齐枚举中文 label）。 */
interface OrderRow {
  matchUnitId?: string;
  mode?: string;
  segmentId?: number;
  spatialType?: string;
  targetSubjects?: string[];
  preferredShot?: string;
  cameraDynamic?: string;
  audioMode?: string;
  fallbackLevel?: number;
  atmosphereNote?: string;
  /** 🎬 展示透传：本工单对应完整句的文案原文 */
  text?: string;
  /** 🎬 展示透传：本工单对应完整句的画面意图描述 */
  visualIntent?: string;
}

/* ==================== 枚举中文 label 映射（与 C0 shotSpec.ts 枚举值逐项对应） ==================== */

/** 空间类型中文 label */
const SPATIAL_TYPE_LABEL: Record<string, string> = {
  INDOOR_RESIDENCE: '室内·住宅',
  INDOOR_PUBLIC: '室内·公共场所',
  OUTDOOR_STREET: '室外·街道',
  OUTDOOR_NATURE: '室外·自然景',
  VEHICLE: '载具内部',
  TRANSIT_HUB: '交通枢纽',
  UNKNOWN: '泛化/未知',
};

/** 景别中文 label */
const PREFERRED_SHOT_LABEL: Record<string, string> = {
  EXTREME_LONG: '大全景',
  LONG_SHOT: '全景',
  FULL_SHOT: '中全景',
  MEDIUM_SHOT: '中景',
  MEDIUM_CLOSE: '中近景',
  CLOSE_SHOT: '近景',
  EXTREME_CLOSE: '特写',
};

/** 运镜中文 label */
const CAMERA_DYNAMIC_LABEL: Record<string, string> = {
  STATIC: '固定',
  PAN: '横摇',
  TILT: '竖摇',
  PUSH: '推',
  PULL: '拉',
  FOLLOW: '跟',
};

/** 工单模式中文 label */
const MODE_LABEL: Record<string, string> = {
  NEW_SHOT: '新开镜',
  CONTINUE_PREV: '顺延上镜',
};

/** 音频模式中文 label */
const AUDIO_MODE_LABEL: Record<string, string> = {
  narration: '解说合成',
  original: '原声段',
};

/** label 兜底：取不到中文映射时原样回显（不崩）。 */
function label(map: Record<string, string>, value?: string): string {
  if (!value) return '-';
  return map[value] ?? value;
}

/** 降级链 L0-L5 中文说明（越小越严）。 */
const FALLBACK_LEVEL_NOTE: Record<number, string> = {
  0: 'L0 硬门禁全命中',
  1: 'L1 同段环境放宽',
  2: 'L2 空镜放宽',
  3: 'L3 同段任意未用',
  4: 'L4 延续放宽',
  5: 'L5 段内复用',
};

const actions = window?.api?.storyboard;

/**
 * 🎬 分镜单面板主组件。
 * 挂载后按 projectId 拉取工单，渲染顶部统计 + 工单卡片列表；无工单/加载失败渲染空态。
 */
export default function StoryboardPanel({ projectId }: { projectId: string }) {
  const [orders, setOrders] = React.useState<OrderRow[]>([]);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async (pid: string) => {
    setLoading(true);
    try {
      // 统一 IPC 响应解包约定：IpcRouter 将业务返回值包成 { success, data }，
      // 实际数据在 res.data 里（可能为 {orders:[]} 对象），此处兼容取 data，避免误读空
      const res = actions ? await actions.loadOrders(pid) : null;
      const body = (res as any)?.data ?? res;
      const list = Array.isArray(body) ? body : (body as any)?.orders;
      setOrders((list ?? []) as OrderRow[]);
    } catch {
      // 拉取失败 => 空态，绝不抛错到外面
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (projectId) void load(projectId);
  }, [projectId, load]);

  // 顶部统计：总数 / 顺延占比
  const total = orders.length;
  const continueCount = orders.filter(o => o.mode === 'CONTINUE_PREV').length;
  const continuePct = total > 0 ? Math.round((continueCount / total) * 100) : 0;

  return (
    <div className="h-full overflow-y-auto px-3.5 py-3 flex flex-col gap-3">
      {/* 顶部统计条 */}
      <div className="grid grid-cols-2 gap-2 shrink-0">
        <div className="glass-card-sm p-2.5 flex flex-col gap-0.5">
          <span className="text-[11px] text-muted-foreground">工单总数</span>
          <span className="text-[18px] font-semibold text-foreground leading-none">{total}</span>
        </div>
        <div className="glass-card-sm p-2.5 flex flex-col gap-0.5">
          <span className="text-[11px] text-muted-foreground">顺延上镜占比</span>
          <span className="text-[18px] font-semibold text-foreground leading-none">{total > 0 ? `${continuePct}%` : '-'}</span>
        </div>
      </div>

      {/* 列表 / 空态 */}
      {loading ? (
        <div className="flex items-center justify-center py-10 text-[12px] text-muted-foreground">加载分镜工单中…</div>
      ) : orders.length === 0 ? (
        <div className="glass-card-sm p-5 flex flex-col items-center justify-center text-muted-foreground">
          <ClapperboardIcon className="opacity-30 mb-2" />
          <span className="text-[12px]">暂无分镜工单</span>
          <span className="text-[11px] opacity-60 mt-1">执行完步骤3生成解说文案后，此处自动展示分镜工单</span>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {orders.map((order, idx) => (
            <OrderCard key={order.matchUnitId ?? idx} order={order} index={idx} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 单张工单卡片：段号 + 空间 + 主体徽章 + 景别/运镜 + 模式/降级 + 备注 + 文案/画面意图/镜头摘要。 */
function OrderCard({ order, index }: { order: OrderRow; index: number }) {
  const isContinue = order.mode === 'CONTINUE_PREV';
  // 🔍 镜头方案摘要：景别 · 运镜 · 空间（缺省省略对应片段，全部缺失则整行省略）
  const shotSummary = [label(PREFERRED_SHOT_LABEL, order.preferredShot), label(CAMERA_DYNAMIC_LABEL, order.cameraDynamic), label(SPATIAL_TYPE_LABEL, order.spatialType)]
    .filter(v => v && v !== '-')
    .join(' · ');
  return (
    <div className={`glass-card-sm p-2.5 flex flex-col gap-1.5 ${isContinue ? 'opacity-80' : ''}`}>
      {/* 首行：序号 + 段号 + 模式 */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[11px] font-mono text-muted-foreground shrink-0">#{index + 1}</span>
          <code className="text-[11px] font-mono bg-bg-secondary px-1.5 py-0.5 rounded truncate text-foreground">
            段 {order.segmentId ?? '-'}
          </code>
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
              isContinue ? 'bg-amber-500/20 text-amber-400' : 'bg-accent/15 text-accent'
            }`}
          >
            {label(MODE_LABEL, order.mode)}
          </span>
        </div>
        <span className="text-[10px] text-muted-foreground font-mono shrink-0 truncate ml-2" title={order.matchUnitId}>
          降级 {order.fallbackLevel != null ? `L${order.fallbackLevel}` : '-'}
        </span>
      </div>

      {/* 🎬 文案原文：本分镜对应的完整句台词 */}
      {order.text ? (
        <div className="text-[11px] text-foreground leading-snug line-clamp-2" title={order.text}>
          {order.text}
        </div>
      ) : null}

      {/* 🎬 镜头方案摘要：景别 · 运镜 · 空间 */}
      {shotSummary ? (
        <div className="text-[10px] text-accent font-medium truncate" title={shotSummary}>
          {shotSummary}
        </div>
      ) : null}

      {/* 主体徽章 */}
      <div className="flex flex-wrap gap-1">
        {(order.targetSubjects ?? []).map(s => (
          <span key={s} className="text-[11px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">
            {s}
          </span>
        ))}
        {(order.targetSubjects ?? []).length === 0 && (
          <span className="text-[11px] text-muted-foreground">无主体（环境句）</span>
        )}
      </div>

      {/* 空间 / 景别 / 运镜 / 音频 */}
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="truncate" title={label(SPATIAL_TYPE_LABEL, order.spatialType)}>
          空间：{label(SPATIAL_TYPE_LABEL, order.spatialType)}
        </span>
        <span className="shrink-0">景别：{label(PREFERRED_SHOT_LABEL, order.preferredShot)}</span>
        <span className="shrink-0">运镜：{label(CAMERA_DYNAMIC_LABEL, order.cameraDynamic)}</span>
        <span className="shrink-0">音频：{label(AUDIO_MODE_LABEL, order.audioMode)}</span>
      </div>

      {/* 🎬 画面意图：本句的视觉意图描述 */}
      {order.visualIntent ? (
        <div className="text-[10px] text-muted-foreground/80 leading-snug line-clamp-2" title={order.visualIntent}>
          画面意图：{order.visualIntent}
        </div>
      ) : null}

      {/* 降级说明 + 备注 */}
      <div className="text-[10px] text-muted-foreground/80">
        <span>{order.fallbackLevel != null ? (FALLBACK_LEVEL_NOTE[order.fallbackLevel] ?? `L${order.fallbackLevel}`) : '-'}</span>
        {order.atmosphereNote && <span className="ml-2 truncate block" title={order.atmosphereNote}>备注：{order.atmosphereNote}</span>}
      </div>
    </div>
  );
}

/** 空态分镜图标（lucide Clapperboard）。 */
function ClapperboardIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z" />
      <path d="m6.2 5.3 3.1 3.9" />
      <path d="m12.4 3.4 3.1 4" />
      <path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}