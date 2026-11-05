// Module: editor/shell/utils/pipelineArtifactState
// 阶段1：产物版本统一写入 API（beginStepRun / commitArtifacts / failStepRun / touchArtifact）。
//
// 本文件是**唯一的产物版本写入入口**：各执行入口（orchestrator、步骤3/4/5 独立流程、
// 步骤1 抽取完成回调）都必须经由此处写入 rev/stamp，禁止直接改 usePipelineStore.artifactMeta。
//
// 阶段2：版本元数据随「begin 先失效并落盘 / commit / fail / abort」写入 SQLite metadata；
// 恢复入口见 normalizeArtifactMeta（旧项目补 legacy stamp）。
// 阶段1 保留的 invalidateDownstreamSteps 手工失效调用暂不删除（阶段4 收敛）。

import { API } from '@renderer/api';
import { usePipelineStore } from '@renderer/store/usePipelineStore';
import { useProjectStore } from '@modules/editor/stores/useProjectStore';
import { useStep1Store } from '@modules/pipeline/stores/useStep1Store';
import { useStep3Store } from '@modules/pipeline/stores/useStep3Store';
import { useStep4Store } from '@modules/pipeline/stores/useStep4Store';
import { useStep5Store } from '@modules/pipeline/stores/useStep5Store';
import {
  KEY_VERSION,
  artifactSubStepName,
  computeInputKey,
  createEmptyArtifactMeta,
  downstreamArtifactKeys,
  evaluateArtifact,
  evaluateStep1Artifact,
  getEnabledStep1Keys,
  type ArtifactInputContext,
  type ArtifactKey,
  type ArtifactMeta,
  type ArtifactStamp,
  type ArtifactState,
  type Step1SubStepKey,
} from './pipelineArtifactMeta';

/** 一次步骤执行的冻结凭证：fromKey 在 begin 时固定，commit/fail 都复用它 */
export interface StepRunHandle {
  key: ArtifactKey;
  fromKey: string;
}

/** 进行中的执行凭证（按产物键）。步骤1 的完成由异步抽取回调触发，需要跨调用取回冻结值 */
const pendingRuns = new Map<ArtifactKey, StepRunHandle>();

/** 读取当前产物版本元数据（store 尚未初始化时给空结构） */
function currentMeta(): ArtifactMeta {
  return usePipelineStore.getState().artifactMeta ?? createEmptyArtifactMeta();
}

/** 采集当前输入快照（只读，供 computeInputKey 使用） */
export function buildArtifactInputContext(): ArtifactInputContext {
  const project = useProjectStore.getState();
  const step1 = useStep1Store.getState();
  const step3 = useStep3Store.getState();
  const step4 = useStep4Store.getState();
  const step5 = useStep5Store.getState();
  const meta = currentMeta();
  const media = project.mediaItems?.[0];

  return {
    media: media ? { id: media.id, filePath: media.filePath } : null,
    extractionConfig: step1.extractionConfig ?? undefined,
    revs: meta.revs,
    scriptConfig: {
      style: step3.scriptStyle,
      speechRate: step3.speechRate,
      pipelineParams: step3.pipelineParams,
    },
    ttsConfig: {
      engine: step4.ttsEngine,
      voiceId: step4.ttsVoiceId,
      speechRate: step4.speechRate,
    },
    asrLines: step1.asrLines,
    roles: project.roles,
    bgm: step5.activeBgm ? { id: step5.activeBgm.id, filePath: step5.activeBgm.filePath } : null,
  };
}

/** 下游产物键（依赖图传递闭包） */
function downstreamKeys(key: ArtifactKey): ArtifactKey[] {
  return downstreamArtifactKeys(key);
}

function writeMeta(meta: ArtifactMeta): void {
  usePipelineStore.getState().setArtifactMeta(meta);
}

/**
 * 阶段2：版本元数据单独落盘（只写 artifactStamps，避免整包重写数据）。
 * 落盘失败不阻断执行：内存态已失效，最坏情况是跨会话恢复时退化为 legacy（只警告不阻断）。
 */
async function persistArtifactMeta(): Promise<void> {
  const projectId = useProjectStore.getState().projectId;
  const saveData = (API as any)?.project?.saveData;
  if (!projectId || typeof saveData !== 'function') return;
  try {
    await saveData(projectId, { artifactStamps: usePipelineStore.getState().artifactMeta });
  } catch (e) {
    console.error('[产物版本] artifactStamps 落盘失败', e);
  }
}

/**
 * 单个产物的当前有效性（阶段4：自动跳过 / UI 过期提示共用）。
 * 与 evaluateProjectArtifacts 同源，避免两处判定口径分叉。
 * 步骤1 子键的状态取自 subStepStatuses，步骤键取自 stepStatuses。
 */
export function getArtifactState(key: ArtifactKey): ArtifactState {
  const ps = usePipelineStore.getState();
  const subName = artifactSubStepName(key);
  const status = subName
    ? ps.subStepStatuses[subName] ?? 'idle'
    : ps.stepStatuses[Number(key) - 1] ?? 'idle';
  return evaluateArtifact({
    key,
    status,
    meta: ps.artifactMeta,
    currentInputKey: computeInputKey(key, buildArtifactInputContext()),
  }).state;
}

/** 是否可被自动流水线跳过（严格仅 valid：legacy/missing/unverified/stale 都不跳过） */
export function isStepArtifactValid(key: ArtifactKey): boolean {
  return getArtifactState(key) === 'valid';
}

/** 该产物键是否有进行中的执行凭证（步骤1 回调据此判断本次是否执行了该子步骤） */
export function hasPendingStepRun(key: ArtifactKey): boolean {
  return pendingRuns.has(key);
}

/** 当前项目各产物的有效性（导出阻断 / 自动流转门禁共用；键固定为步骤 1~5） */
export function evaluateProjectArtifacts(): Array<{
  key: '1' | '2' | '3' | '4' | '5';
  state: ArtifactState;
  autoFlow: boolean;
  exportBlocked: boolean;
}> {
  const ps = usePipelineStore.getState();
  const ctx = buildArtifactInputContext();
  const memo = new Map<ArtifactKey, string>();
  const inputKeyOf = (key: ArtifactKey) => computeInputKey(key, ctx, memo);

  // 步骤1：启用子步骤全部有效才算有效
  const enabledKeys = getEnabledStep1Keys(useStep1Store.getState().extractionConfig);
  const currentInputKeys: Partial<Record<Step1SubStepKey, string>> = {};
  enabledKeys.forEach((key) => {
    currentInputKeys[key] = inputKeyOf(key);
  });
  const step1 = evaluateStep1Artifact({
    status: ps.stepStatuses[0] ?? 'idle',
    meta: ps.artifactMeta,
    enabledKeys,
    currentInputKeys,
  });

  const result: Array<{
    key: '1' | '2' | '3' | '4' | '5';
    state: ArtifactState;
    autoFlow: boolean;
    exportBlocked: boolean;
  }> = [{
    key: '1',
    state: step1.state,
    autoFlow: step1.autoFlow,
    exportBlocked: step1.exportBlocked,
  }];

  (['2', '3', '4', '5'] as const).forEach((key, idx) => {
    const evaluation = evaluateArtifact({
      key,
      status: ps.stepStatuses[idx + 1] ?? 'idle',
      meta: ps.artifactMeta,
      currentInputKey: inputKeyOf(key),
    });
    result.push({
      key,
      state: evaluation.state,
      autoFlow: evaluation.autoFlow,
      exportBlocked: evaluation.exportBlocked,
    });
  });

  return result;
}

/**
 * 开始执行：冻结输入指纹，并把本产物与下游产物标记为失效（rev 不变）。
 * 阶段2 起「先失效并落盘」：await 落盘后才允许调用方继续执行，
 * 保证执行中途关闭应用/崩溃时，重开项目看到的是 valid=false 而不是旧的有效产物。
 */
export async function beginStepRun(key: ArtifactKey): Promise<StepRunHandle> {
  const fromKey = computeInputKey(key, buildArtifactInputContext());
  const handle: StepRunHandle = { key, fromKey };
  pendingRuns.set(key, handle);

  const meta = currentMeta();
  const stamps = { ...meta.stamps };

  // 本产物：已标记失效（无历史 stamp 时不凭空创建，等 commit 再产生）
  const selfStamp = stamps[key];
  if (selfStamp) stamps[key] = { ...selfStamp, valid: false };

  // 下游：一律失效，防止旧产物被自动流转/导出复用
  downstreamKeys(key).forEach((k) => {
    const stamp = stamps[k];
    if (stamp) stamps[k] = { ...stamp, valid: false };
  });

  writeMeta({ revs: { ...meta.revs }, stamps });
  await persistArtifactMeta();
  return handle;
}

/**
 * 成功提交：rev+1，stamp 记为 renderer 有效。
 * 仅当执行成功且产物非空时调用；空产物必须走 failStepRun。
 */
export async function commitArtifacts(target: ArtifactKey | StepRunHandle): Promise<void> {
  const handle = resolveHandle(target);
  const meta = currentMeta();
  const rev = (meta.revs[handle.key] ?? 0) + 1;
  const stamp: ArtifactStamp = {
    rev,
    fromKey: handle.fromKey,
    keyVersion: KEY_VERSION,
    valid: true,
    source: 'renderer',
  };

  writeMeta({
    revs: { ...meta.revs, [handle.key]: rev },
    stamps: { ...meta.stamps, [handle.key]: stamp },
  });
  pendingRuns.delete(handle.key);
  // 🔑 不做独立落盘：有效版本必须与产物数据同批写入（persistProjectSnapshot 已含 artifactStamps）。
  //   若在此提前落 stamp，崩溃窗口内会出现「新版本戳 + 旧产物数据」被误认证为有效。
}

/**
 * 失败/中止：恢复旧数据由调用方负责；版本上只保持 valid=false，rev 不增加。
 * 阶段2 起立即落盘：失败产物重开后仍是 unverified，不会被当成有效结果导出。
 */
export async function failStepRun(target: ArtifactKey | StepRunHandle): Promise<void> {
  const handle = resolveHandle(target);
  const meta = currentMeta();
  const stamps = { ...meta.stamps };
  const existing = stamps[handle.key];
  if (existing) stamps[handle.key] = { ...existing, valid: false };
  writeMeta({ revs: { ...meta.revs }, stamps });
  pendingRuns.delete(handle.key);
  await persistArtifactMeta();
}

/** 中止语义与失败一致（数据由调用方恢复，版本不得伪装成新结果） */
export const abortStepRun = failStepRun;

/**
 * 手工编辑产物：rev+1、按当前输入重算 fromKey、valid=true，并失效下游。
 * 阶段1 仅提供 API；阶段4 再把各手工编辑 setter 接入。
 */
export async function touchArtifact(key: ArtifactKey): Promise<void> {
  const meta = currentMeta();
  const rev = (meta.revs[key] ?? 0) + 1;
  const stamp: ArtifactStamp = {
    rev,
    fromKey: computeInputKey(key, buildArtifactInputContext()),
    keyVersion: KEY_VERSION,
    valid: true,
    source: 'renderer',
  };
  const stamps = { ...meta.stamps, [key]: stamp };
  downstreamKeys(key).forEach((k) => {
    const existing = stamps[k];
    if (existing) stamps[k] = { ...existing, valid: false };
  });
  writeMeta({ revs: { ...meta.revs, [key]: rev }, stamps });
  pendingRuns.delete(key);
  await persistArtifactMeta();
}

/**
 * 输入型手工改动（ASR 改字/角色改名等）：产物本身并未重算，不能认证为有效。
 * 只把受影响产物标为失效（valid=false），保留 rev 与数据，等待用户重跑；
 * 下游由调用方按依赖关系传入（如 ASR 影响 3/4/5，角色影响 3/4/5）。
 */
export async function markArtifactsStale(keys: ArtifactKey[]): Promise<void> {
  const meta = currentMeta();
  const stamps = { ...meta.stamps };
  let changed = false;
  keys.forEach((k) => {
    const existing = stamps[k];
    if (!existing || existing.valid === false) return;
    stamps[k] = { ...existing, valid: false };
    changed = true;
  });
  if (!changed) return;
  writeMeta({ revs: { ...meta.revs }, stamps });
  await persistArtifactMeta();
}

function resolveHandle(target: ArtifactKey | StepRunHandle): StepRunHandle {
  if (typeof target !== 'string') return target;
  const pending = pendingRuns.get(target);
  if (pending) return pending;
  // 兼容无 begin 的旧调用路径：按当前输入补一个凭证，避免吞掉这次写入记录
  return { key: target, fromKey: computeInputKey(target, buildArtifactInputContext()) };
}

/**
 * 空产物判定（原始执行结果，不读 store）。
 * MATCH 映射在空结果时会保留旧值，因此必须用原始结果判断，否则旧数据会被误认证为新结果。
 */
export function isStepProductEmpty(step: 2 | 3 | 4 | 5, rawResult: unknown): boolean {
  if (!rawResult || typeof rawResult !== 'object') return true;
  const nodeResults = Object.values(rawResult as Record<string, any>)
    .filter((r) => r && typeof r === 'object');

  switch (step) {
    case 2: {
      return !nodeResults.some((r) => {
        if (Array.isArray(r.frames) && r.frames.length > 0) return true;
        if (Array.isArray(r.partialFrames) && r.partialFrames.length > 0) return true;
        return typeof r.sceneDescriptions === 'string' && r.sceneDescriptions.trim().length > 0;
      });
    }
    case 3: {
      return !nodeResults.some(
        (r) => (Array.isArray(r.paragraphs) && r.paragraphs.length > 0)
          || (Array.isArray(r.shots) && r.shots.length > 0),
      );
    }
    case 4: {
      const shots = nodeResults.flatMap((r) =>
        Array.isArray(r.shots) ? r.shots : Array.isArray(r.results) ? r.results : []
      );
      // 全部失败（无可用音频地址）视作空产物
      return !shots.some((s: any) => !s?._failed && (s?.audioUrl || s?.audioPath));
    }
    case 5: {
      return !nodeResults.some(
        (r) => (Array.isArray(r.matches) && r.matches.length > 0)
          || (Array.isArray(r.segments) && r.segments.length > 0),
      );
    }
  }
}
