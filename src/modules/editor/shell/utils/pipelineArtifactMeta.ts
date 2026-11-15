// Module: editor/shell/utils/pipelineArtifactMeta
// 阶段0（只读纯函数）：管线产物版本模型 + 输入指纹 + 有效性判定。
//
// 目标：把「重跑上游必须失效下游」从人工纪律变成结构不变量。
// 本文件只提供纯函数与类型，不读写任何 store，也不产生副作用；
// 落盘/失效的执行逻辑在阶段1 收口到 beginStepRun / commitArtifacts 等 API。
//
// 关键约定：
// 1. revision 语义是「该产物成功写入次数」，不做内容哈希（避免对大数组序列化）。
// 2. fromKey 必须在执行开始时冻结后写入，不能在写库时重算，
//    否则执行期间上游 rev 变化会把旧输入产出的结果误认证为有效。
// 3. keyVersion 用于输入定义变更时的整体升级：旧 fromKey 与新定义「恰好相等」也不会被误判有效。
// 4. 阶段5：步骤1 拆成四个独立产物键（frames/audio/whisper/faces），
//    各自拥有 rev/stamp；步骤1 整体有效 = 所有【启用】子步骤全部有效。
//    下游键通过依赖图携带上游的 rev + 输入指纹，任何上游配置变化都会向下游传播。

import type { ExtractionConfig } from '@modules/pipeline/stores/useStep1Store';

/** 步骤1 的子任务名（与 usePipelineStore.subStepStatuses 的 key 对齐） */
export type Step1SubStep = 'frames' | 'audio' | 'whisper' | 'faces';

/** 步骤1 子步骤产物键：前缀保证与步骤号键区分，且可安全做对象键 */
export type Step1SubStepKey = '1.frames' | '1.audio' | '1.whisper' | '1.faces';

/** 产物键：步骤1 四子步骤 + 步骤2~5 */
export type ArtifactKey = Step1SubStepKey | '2' | '3' | '4' | '5';

export const STEP1_SUBSTEP_KEYS: readonly Step1SubStepKey[] = [
  '1.frames', '1.audio', '1.whisper', '1.faces',
];

export const ARTIFACT_KEYS: readonly ArtifactKey[] = [...STEP1_SUBSTEP_KEYS, '2', '3', '4', '5'];

/** 子任务名 → 产物键 */
export function substepArtifactKey(name: Step1SubStep): Step1SubStepKey {
  return `1.${name}` as Step1SubStepKey;
}

/** 产物键 → 子任务名（非步骤1 子键返回 null） */
export function artifactSubStepName(key: ArtifactKey): Step1SubStep | null {
  if (!key.startsWith('1.')) return null;
  const name = key.slice(2);
  return (['frames', 'audio', 'whisper', 'faces'].includes(name) ? name : null) as Step1SubStep | null;
}

/**
 * 当前配置启用的步骤1 子步骤（配置缺失时按四项全启用）。
 * 步骤1 的整体有效性只由启用子步骤决定：禁用项不产出也不参与门禁。
 */
export function getEnabledStep1Keys(
  config: ExtractionConfig | null | undefined
): Step1SubStepKey[] {
  if (!config) return [...STEP1_SUBSTEP_KEYS];
  return STEP1_SUBSTEP_KEYS.filter((key) => {
    const name = artifactSubStepName(key)!;
    return config[name]?.enabled !== false;
  });
}

/**
 * 产物依赖图（直接上游）。
 * - frames 只影响画面链（步骤2~5），不影响音频/ASR/人脸产物
 * - audio 是 ASR 的输入（分离策略变化 ⇒ ASR 必须重跑）
 * - whisper/faces 影响文案与配音（步骤3~5），不影响步骤2
 */
const DEPENDENCIES: Record<ArtifactKey, readonly ArtifactKey[]> = {
  '1.frames': [],
  '1.audio': [],
  '1.whisper': ['1.audio'],
  '1.faces': [],
  '2': ['1.frames'],
  '3': ['2', '1.whisper', '1.faces'],
  '4': ['3'],
  '5': ['4'],
};

/** 某产物的全部下游（传递闭包，用于 begin/commit/touch 时失效） */
export function downstreamArtifactKeys(key: ArtifactKey): ArtifactKey[] {
  const result = new Set<ArtifactKey>();
  const visit = (current: ArtifactKey) => {
    ARTIFACT_KEYS.forEach((candidate) => {
      if (result.has(candidate)) return;
      if (DEPENDENCIES[candidate].includes(current)) {
        result.add(candidate);
        visit(candidate);
      }
    });
  };
  visit(key);
  return Array.from(result);
}

/** 写入来源：renderer=渲染层正常产出；backend=主进程直写兜底；legacy=历史项目缺元数据 */
export type ArtifactSource = 'renderer' | 'backend' | 'legacy';

export interface ArtifactStamp {
  /** 该产物成功写入次数（0 表示未产出） */
  rev: number;
  /** 执行开始时冻结的输入指纹 */
  fromKey: string;
  /** 输入定义版本，字段演进时防集体误判 */
  keyVersion: number;
  /** 保守门禁：false 一定不可用；true 仍需同时满足 status completed */
  valid: boolean;
  source: ArtifactSource;
}

export interface ArtifactMeta {
  revs: Partial<Record<ArtifactKey, number>>;
  stamps: Partial<Record<ArtifactKey, ArtifactStamp>>;
}

/**
 * 输入定义版本。
 * 修改 computeInputKey 中任一步骤所取的字段集合时必须 +1，
 * 避免旧 fromKey 与新定义「恰好相等」而被误认证为有效。
 * v2（阶段5）：步骤1 拆分为四个子步骤键，且下游键改为依赖图递归指纹。
 */
export const KEY_VERSION = 2;

export function createEmptyArtifactMeta(): ArtifactMeta {
  return { revs: {}, stamps: {} };
}

/** 读取产物 rev；缺失/旧项目返回 0（0 视作无产物） */
export function readArtifactRev(meta: ArtifactMeta | null | undefined, key: ArtifactKey): number {
  return meta?.revs?.[key] ?? 0;
}

/** computeInputKey 所需的上下文（只读快照，不依赖 store 实例） */
export interface ArtifactInputContext {
  /** 素材身份：替换素材文件后步骤1 必须重跑 */
  media?: { id?: string; filePath?: string } | null;
  /** 步骤1 抽帧/音频/ASR/人脸/裁剪配置 */
  extractionConfig?: ExtractionConfig;
  /** 各产物当前 rev（未产出为 0） */
  revs?: Partial<Record<ArtifactKey, number>>;
  /** 步骤3 文案生成配置（style / 基准语速 / 融合参数 / 风格包） */
  scriptConfig?: { style?: string; speechRate?: number; pipelineParams?: unknown; stylePack?: unknown };
  /** 步骤4 TTS 配置（speechRate 为合成语速倍率，非步骤3 的字/秒） */
  ttsConfig?: { engine?: string; voiceId?: string; speechRate?: number; pauseMs?: number };
  /** ASR 台词：改字/删行/改时间轴都会改变指纹 */
  asrLines?: ReadonlyArray<{ startMs?: number; endMs?: number; text?: string }>;
  /** 人物角色名：角色改名影响 3/4/5 的解说人称（不影响步骤2 画面描述） */
  roles?: ReadonlyArray<{ name?: string }>;
  /** 步骤5 BGM：换/删 BGM 影响匹配节奏；null 表示已删除 */
  bgm?: { id?: string; filePath?: string } | null;
}

/**
 * 计算某产物「当前输入」的指纹。
 * 结构：`<key>|kv<版本>|<自身输入指纹>|deps=<上游键:r<上游rev>:<上游输入指纹哈希>,...>`
 * - 自身 rev 不属于输入（否则 commit 提升 rev 后自身立即 stale）；
 * - 下游键递归携带上游 rev + 上游输入指纹，因此上游配置变化即使尚未重跑，下游也会立即判为过期；
 *   上游重跑（rev+1）同样会改变下游指纹。
 */
export function computeInputKey(key: ArtifactKey, ctx: ArtifactInputContext, memo?: Map<ArtifactKey, string>): string {
  const kv = `kv${KEY_VERSION}`;
  const cache = memo ?? new Map<ArtifactKey, string>();
  const cached = cache.get(key);
  if (cached) return cached;

  const deps = DEPENDENCIES[key];
  const depFingerprint = deps.length > 0
    ? `deps=${deps.map((dep) =>
        `${dep}:r${ctx.revs?.[dep] ?? 0}:${hashOf(computeInputKey(dep, ctx, cache))}`
      ).join(',')}`
    : '';
  const result = [
    key,
    kv,
    ownInputFingerprint(key, ctx),
    depFingerprint,
  ].filter(Boolean).join('|');

  cache.set(key, result);
  return result;
}

/** 单个产物自身的配置指纹（不含上游 rev/输入） */
function ownInputFingerprint(key: ArtifactKey, ctx: ArtifactInputContext): string {
  const cfg = ctx.extractionConfig;
  const media = ctx.media ?? null;
  const trim = cfg?.mediaTrim ?? null;

  switch (key) {
    case '1.frames':
      return `in=${hashOf({ media, frames: framesDigest(cfg), trim })}`;

    case '1.audio':
      return `in=${hashOf({ media, audio: cfg?.audio ?? null, trim })}`;

    case '1.whisper':
      return `in=${hashOf({
        media,
        whisper: cfg?.whisper ?? null,
        targetLanguage: cfg?.targetLanguage ?? null,
        trim,
      })}`;

    case '1.faces':
      return `in=${hashOf({ media, faces: cfg?.faces ?? null, trim })}`;

    case '2':
      // 画面描述只看抽帧产物（依赖图）与拼图模式；ASR/角色改名不影响步骤2
      return `m=${cfg?.frames?.matrixMode ?? 'auto'}`;

    case '3':
      return [
        `cfg=${hashOf(ctx.scriptConfig ?? {})}`,
        `asr=${hashOf(normalizeAsrLines(ctx.asrLines))}`,
        `roles=${hashOf(normalizeRoles(ctx.roles))}`,
      ].join('|');

    case '4':
      // 文案内容变化由上游 rev3 表示；TTS 只看引擎/音色/合成语速
      return `tts=${hashOf(ctx.ttsConfig ?? {})}`;

    case '5':
      return [
        `asr=${hashOf(normalizeAsrLines(ctx.asrLines))}`,
        `roles=${hashOf(normalizeRoles(ctx.roles))}`,
        `bgm=${hashOf(ctx.bgm ? { id: ctx.bgm.id ?? '', filePath: ctx.bgm.filePath ?? '' } : null)}`,
      ].join('|');
  }
}

/** 抽帧配置指纹：剔除 matrixMode / deprecated density（属于步骤2 输入，不影响抽帧产物） */
function framesDigest(cfg: ExtractionConfig | undefined): Record<string, unknown> | null {
  if (!cfg) return null;
  const frames = (cfg.frames ?? {}) as Record<string, unknown>;
  const digest: Record<string, unknown> = {};
  Object.keys(frames).forEach((k) => {
    if (k === 'matrixMode' || k === 'density') return;
    digest[k] = frames[k];
  });
  return digest;
}

function normalizeAsrLines(
  lines: ArtifactInputContext['asrLines']
): Array<{ startMs: number; endMs: number; text: string }> {
  if (!Array.isArray(lines)) return [];
  return lines.map((l) => ({
    startMs: typeof l?.startMs === 'number' ? l.startMs : 0,
    endMs: typeof l?.endMs === 'number' ? l.endMs : 0,
    text: typeof l?.text === 'string' ? l.text : '',
  }));
}

function normalizeRoles(roles: ArtifactInputContext['roles']): string[] {
  if (!Array.isArray(roles)) return [];
  return roles.map((r) => String(r?.name ?? '').trim());
}

/** 稳定序列化：对象键排序、忽略 undefined，保证同义配置指纹一致 */
function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);
  if (type === 'number' || type === 'boolean' || type === 'bigint') return String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (type === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

/** FNV-1a 32 位（跨平台/跨会话稳定），base36 输出 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0');
}

function hashOf(value: unknown): string {
  return fnv1a(stableStringify(value));
}

/** 单条 stamp 的存储清洗：字段非法时降级为 legacy（不可认证为有效） */
function sanitizeStamp(raw: unknown): ArtifactStamp | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const rev = Number(r.rev);
  if (!Number.isFinite(rev) || rev < 0) return null;
  const source: ArtifactSource = r.source === 'renderer' || r.source === 'backend'
    ? r.source
    : 'legacy';
  return {
    rev: Math.floor(rev),
    fromKey: typeof r.fromKey === 'string' ? r.fromKey : '',
    keyVersion: typeof r.keyVersion === 'number' && Number.isFinite(r.keyVersion) ? r.keyVersion : 0,
    // 来源无法识别的产物一律不可认证（legacy 不参与自动流转）
    valid: source === 'legacy' ? false : r.valid === true,
    source,
  };
}

/**
 * 恢复/清洗持久化的版本元数据（hydrate 入口）。
 * 旧项目（无 artifactStamps）中已完成的步骤补 legacy stamp：
 * 允许查看与导出（不阻断），但不会被自动流水线跳过，也不会被认证为有效。
 *
 * 阶段5 兼容：阶段4 之前的粗粒度键 '1' 会展开为四个子步骤的 legacy stamp，
 * 避免旧 fromKey 在新定义下被判为 stale 而误阻断导出。
 */
export function normalizeArtifactMeta(
  raw: unknown,
  stepCompleted: readonly boolean[] = []
): ArtifactMeta {
  const meta = createEmptyArtifactMeta();
  let legacyStep1Rev = 0;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as { revs?: Record<string, unknown>; stamps?: Record<string, unknown> };
    ARTIFACT_KEYS.forEach((key) => {
      const stamp = sanitizeStamp(r.stamps?.[key]);
      if (stamp) {
        meta.stamps[key] = stamp;
        meta.revs[key] = stamp.rev;
      }
      const rawRev = Number(r.revs?.[key]);
      if (Number.isFinite(rawRev) && rawRev > 0) meta.revs[key] = Math.floor(rawRev);
    });
    // 旧粗粒度键 '1'（阶段4 及以前）
    const legacyStamp = sanitizeStamp(r.stamps?.['1']);
    const legacyRev = Number(r.revs?.['1']);
    legacyStep1Rev = legacyStamp?.rev
      ?? (Number.isFinite(legacyRev) && legacyRev > 0 ? Math.floor(legacyRev) : 0);
  }

  // 步骤1：逐子步骤补 legacy（已有子键 stamp 时保留）
  STEP1_SUBSTEP_KEYS.forEach((key) => {
    if (meta.stamps[key]) return;
    const rev = legacyStep1Rev > 0 ? legacyStep1Rev : (stepCompleted[0] ? 1 : 0);
    if (rev <= 0) return;
    meta.revs[key] = rev;
    meta.stamps[key] = { rev, fromKey: '', keyVersion: 0, valid: false, source: 'legacy' };
  });

  // 步骤2~5
  (['2', '3', '4', '5'] as const).forEach((key, idx) => {
    if (meta.stamps[key]) return;
    if (!stepCompleted[idx + 1]) return;
    const rev = meta.revs[key] && meta.revs[key]! > 0 ? meta.revs[key]! : 1;
    meta.revs[key] = rev;
    meta.stamps[key] = { rev, fromKey: '', keyVersion: 0, valid: false, source: 'legacy' };
  });

  return meta;
}

/** 产物有效性判定结果 */
export type ArtifactState =
  /** 状态已完成 + rev>0 + fromKey/keyVersion 匹配 + valid=true + 非 backend */
  | 'valid'
  /** 历史项目缺元数据：不阻断，但不自动流转/跳过，UI 提示可重跑 */
  | 'legacy'
  /** 输入指纹不匹配：已过期，不得自动流转，导出必须阻断 */
  | 'stale'
  /** 元数据存在但已被标记失效（如 backend 直写 / 失败后恢复）：导出必须阻断 */
  | 'unverified'
  /** 无产物版本记录（rev=0 或无 stamp）：按 legacy 处理，只警告 */
  | 'missing'
  /** 步骤状态不是 completed（运行态以 status 为准） */
  | 'not-completed';

export interface ArtifactEvaluation {
  state: ArtifactState;
  /** 自动流水线是否可以跳过该步骤（严格：仅 valid） */
  autoFlow: boolean;
  /** 导出是否必须阻断（仅 stale / unverified） */
  exportBlocked: boolean;
  /** 命中的 stamp（便于日志/UI 取证；legacy 缺失时为 null） */
  stamp: ArtifactStamp | null;
}

export interface EvaluateArtifactParams {
  key: ArtifactKey;
  /** 对应步骤状态（usePipelineStore.stepStatuses[key-1]） */
  status: string;
  meta: ArtifactMeta | null | undefined;
  /** computeInputKey 的当前计算结果 */
  currentInputKey: string;
}

/**
 * 判定某产物当前是否有效。
 * 运行态仍以 status 为即时真源；版本负责跨入口、跨会话的正确性。
 */
export function evaluateArtifact(params: EvaluateArtifactParams): ArtifactEvaluation {
  const { key, status, meta, currentInputKey } = params;
  const stamp = meta?.stamps?.[key] ?? null;
  const rev = meta?.revs?.[key] ?? stamp?.rev ?? 0;

  const notCompleted: ArtifactEvaluation = {
    state: 'not-completed',
    autoFlow: false,
    exportBlocked: false,
    stamp,
  };
  if (status !== 'completed') return notCompleted;

  // 无版本记录（旧项目 / 未落盘 / rev=0）：保留现状但只警告，不阻断
  if (!stamp || rev <= 0) {
    return { state: 'missing', autoFlow: false, exportBlocked: false, stamp };
  }

  // 旧项目显式标记：不认证为有效，也不阻断导出
  if (stamp.source === 'legacy') {
    return { state: 'legacy', autoFlow: false, exportBlocked: false, stamp };
  }

  if (stamp.keyVersion !== KEY_VERSION || stamp.fromKey !== currentInputKey) {
    return { state: 'stale', autoFlow: false, exportBlocked: true, stamp };
  }

  // valid=false 或主进程直写：不可自动流转，导出阻断
  if (!stamp.valid || stamp.source === 'backend') {
    return { state: 'unverified', autoFlow: false, exportBlocked: true, stamp };
  }

  return { state: 'valid', autoFlow: true, exportBlocked: false, stamp };
}

/** 布尔便捷入口（自动流转/跳过用） */
export function isArtifactValid(params: EvaluateArtifactParams): boolean {
  return evaluateArtifact(params).state === 'valid';
}

export interface EvaluateStep1Params {
  /** 步骤1 总状态（usePipelineStore.stepStatuses[0]） */
  status: string;
  meta: ArtifactMeta | null | undefined;
  /** 当前启用的子步骤（禁用的子步骤不参与聚合） */
  enabledKeys: readonly Step1SubStepKey[];
  /** 各子步骤 computeInputKey 的当前值 */
  currentInputKeys: Partial<Record<Step1SubStepKey, string>>;
}

/**
 * 步骤1 聚合判定：只有【全部启用子步骤】都 valid 才算有效。
 * 任一子步骤 stale/unverified ⇒ 整体导出阻断；legacy/missing ⇒ 不阻断但不自动流转。
 */
export function evaluateStep1Artifact(params: EvaluateStep1Params): ArtifactEvaluation {
  const { status, meta, enabledKeys, currentInputKeys } = params;

  if (status !== 'completed') {
    return { state: 'not-completed', autoFlow: false, exportBlocked: false, stamp: null };
  }
  if (enabledKeys.length === 0) {
    // 没有启用的子步骤 ⇒ 无产物可认证，保持保守
    return { state: 'missing', autoFlow: false, exportBlocked: false, stamp: null };
  }

  const evaluations = enabledKeys.map((key) => evaluateArtifact({
    key,
    status: 'completed',
    meta,
    currentInputKey: currentInputKeys[key] ?? '',
  }));

  if (evaluations.every((e) => e.state === 'valid')) {
    return { state: 'valid', autoFlow: true, exportBlocked: false, stamp: null };
  }
  if (evaluations.some((e) => e.exportBlocked)) {
    const state: ArtifactState = evaluations.some((e) => e.state === 'stale')
      ? 'stale'
      : 'unverified';
    return { state, autoFlow: false, exportBlocked: true, stamp: null };
  }
  if (evaluations.some((e) => e.state === 'legacy')) {
    return { state: 'legacy', autoFlow: false, exportBlocked: false, stamp: null };
  }
  return { state: 'missing', autoFlow: false, exportBlocked: false, stamp: null };
}
