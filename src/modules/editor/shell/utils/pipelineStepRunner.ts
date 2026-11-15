// Module: editor/shell/utils/pipelineStepRunner
// 阶段3：步骤 2~5 的统一执行入口（runStep）。
//
// 设计目标（见《管线产物版本化与单步入口-设计方案》3.4）：
//   guard → beginStepRun（冻结 fromKey、失效下游、落盘）
//   → status=running → 数据快照 → StepDef.before
//   → buildParams → runPipeline → 校验空产物 → StepDef.finalize
//   → commitArtifacts → completed → 落盘
//   catch → abort? abortStepRun : failStepRun（恢复快照、valid=false、落盘）
//
// 历史形态：orchestrator.executeStep 与步骤3/4/5 Container 各自实现同一流程，
// 且各带不同防线（步骤3 断句/原声拆分、步骤4 语速、步骤5 asrLines/K2 锁定）。
// 现在这些差异全部收进 StepDef，三处入口只调用 runStep，payload/行为逐项一致。

import { AppNotifier } from '@renderer/core/AppNotifier';
import { API } from '@renderer/api';
import { editorLogger } from '@renderer/core/logger/EditorLogger';
import { usePipelineStore } from '@renderer/store/usePipelineStore';
import { useProjectStore } from '@modules/editor/stores/useProjectStore';
import { useEditorNavStore } from '@modules/editor/stores/useEditorNavStore';
import { useStep1Store } from '@modules/pipeline/stores/useStep1Store';
import { useStep2Store } from '@modules/pipeline/stores/useStep2Store';
import { useStep3Store } from '@modules/pipeline/stores/useStep3Store';
import { useStep4Store } from '@modules/pipeline/stores/useStep4Store';
import { useStep5Store } from '@modules/pipeline/stores/useStep5Store';
import { AppError, ErrorCode } from '@modules/infra/error/AppError';
import { STEP_SEQUENCES } from './pipelineConstants';
import { mapPipelineResultToState, type PipelineResultMappers } from '../frontend/hooks/usePipelineResultMapper';
import { persistProjectSnapshot } from './persistSnapshot';
import { invalidateDownstreamSteps } from './invalidateDownstreamSteps';
import {
  capturePipelineDataSnapshot,
  restorePipelineDataSnapshot,
  type PipelineDataSnapshot,
} from './pipelineDataSnapshot';
import {
  abortStepRun,
  beginStepRun,
  commitArtifacts,
  failStepRun,
  isStepArtifactValid,
  isStepProductEmpty,
  type StepRunHandle,
} from './pipelineArtifactState';
import type { ArtifactKey } from './pipelineArtifactMeta';
import { breakLongParagraphs } from '@modules/pipeline/step3-script/frontend/breakLongParagraphs';
import { resolveScriptMatchUnitMode } from '../../../../shared/utils/scriptMatchUnit';
import { normalizeScriptParagraph } from '../../../../shared/utils/normalizeScriptParagraph';
import { diffParagraphs, applyDiffUpdate } from './scriptDiffTree';

/** 可单步执行的步骤（步骤1 由 startCurrentStep 的子任务链执行） */
export type RunnableStep = 2 | 3 | 4 | 5;

export type StepRunStatus = 'completed' | 'failed' | 'aborted' | 'skipped';

/** 入口可显式覆盖的参数（默认以 store 为准，避免组件本地 state 漂移） */
export interface StepUiOverrides {
  scriptStyle?: string;
  speechRate?: number;
  ttsEngine?: string;
  ttsVoiceId?: string;
  voiceId?: string;
}

export interface StepRunOptions {
  /** true = 用户主动启动，跳过「已完成步骤自动跳过」检查 */
  force?: boolean;
  uiOverrides?: StepUiOverrides;
}

export interface StepRunResult {
  status: StepRunStatus;
  step: RunnableStep;
  error?: string;
  skippedReason?: string;
}

interface StepRunContext {
  step: RunnableStep;
  projectId: string;
  force: boolean;
  uiOverrides?: StepUiOverrides;
  /** 执行前数据快照：失败/中止时恢复，避免抹掉上一次可用产物 */
  snapshot: PipelineDataSnapshot;
}

interface StepDef {
  id: RunnableStep;
  /** 前置校验：返回非空字符串表示「不执行并提示」（不改产物版本）；抛错按失败处理 */
  guard?: (ctx: StepRunContext) => string | null;
  /** 执行前清理本步骤自己的旧产物 / 捕获本次执行需要的现场（快照已保存，失败会恢复） */
  before?: (ctx: StepRunContext) => unknown;
  /** 组装注入每个管线节点的参数（与历史各入口的 payload 保持逐项一致） */
  buildParams: (ctx: StepRunContext, node: any) => Record<string, any>;
  /** 原始结果后处理（步骤3 断句/原声拆分、步骤5 K2 锁定恢复）；抛错即按失败处理 */
  finalize?: (raw: any, ctx: StepRunContext, runState: unknown) => void;
  /** 空产物判定（读原始执行结果，不读 store） */
  isEmpty: (raw: any) => boolean;
  missingMessage: string;
  emptyMessage: string;
  failureMessage: string;
}

/** 管线结果 → 各步骤 Store 的 Setter 桥接（与 usePipelineOrchestrator.buildMappers 同源） */
const buildMappers = (): PipelineResultMappers => ({
  setAudioSeparated: useStep1Store.getState().setAudioSeparated,
  setAsrLines: useStep1Store.getState().setAsrLines,
  setFrameCount: useStep1Store.getState().setFrameCount,
  setExtractedData: useProjectStore.getState().setExtractedData,
  setVlmFrames: useStep2Store.getState().setVlmFrames,
  setScriptParagraphs: useStep3Store.getState().setScriptParagraphs,
  setTtsResults: useStep4Store.getState().setTtsResults,
  setTtsProgress: useStep4Store.getState().setTtsProgress,
  setMatchResults: useStep5Store.getState().setMatchResults,
  setVideoChunks: useStep5Store.getState().setVideoChunks,
  setBeatTimestamps: useStep5Store.getState().setBeatTimestamps,
  setMatchDiagnostics: useStep5Store.getState().setMatchDiagnostics,
});

// ── 每次执行独立的 runId/token：中止只影响本次执行，旧任务无法在新一轮里继续写库 ──
let currentRunToken: string | null = null;
const abortedRunTokens = new Set<string>();

const createRunToken = () => `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const isRunAborted = (token: string) => abortedRunTokens.has(token);
const finishRun = (token: string) => {
  abortedRunTokens.delete(token);
  if (currentRunToken === token) currentRunToken = null;
};

/** 标记当前执行被中止，返回被标记的 token（供调用方判断是否已换轮） */
export function markActiveRunAborted(): string | null {
  const target = currentRunToken;
  if (target) abortedRunTokens.add(target);
  return target;
}

/** 当前活跃 token 是否仍是调用方拿到的那次执行 */
export function isActiveRunToken(token: string | null): boolean {
  return token !== null && currentRunToken === token;
}

/** 释放活跃 token（保留中止集合，保证仍挂起的旧任务能感知中止） */
export function releaseActiveRunToken(): void {
  currentRunToken = null;
}

/** 强制重置：新会话/重置状态时清空令牌集合 */
export function resetRunTokens(): void {
  abortedRunTokens.clear();
  currentRunToken = null;
}

// ── 步骤3 后处理：id 兜底 + 原声段保留 + 解说段断句 + Normalizer 净化 ──
function finalizeStep3(raw: any, previousParagraphs: any[]): void {
  const nodeResult = raw?.['script-1'] || raw?.['script'] || raw;
  /** ✅ 身份键统一：段落主键 id 出生处(ScriptGenStrategy)为 seg_N；异常/历史路径可能缺 id，
   *  一旦为空，下游 breakLongParagraphs 会回落到 `para_${idx}` 兜底，多批次拼接即撞号
   *  → React「two children with same key」→ 段落重复/漏渲染（实测 2026-10-08 20:26 日志）。
   *  此处做最终防线：缺 id 者用 rawParagraphs 下标兜底，保证主键全局唯一。 */
  const rawSource = nodeResult?.paragraphs || nodeResult?.shots || [];
  const missingIdCount = rawSource.filter((p: any) => !p?.id).length;
  if (missingIdCount > 0) {
    console.warn(`[步骤3] 段落主键 id 缺失 ${missingIdCount}/${rawSource.length} 个，已用 seg_{idx} 兜底（请核查后端 ScriptGenStrategy 为何未输出 id）`);
  }
  const rawParagraphs = rawSource.map((p: any, idx: number) => ({
    id: p.id || `seg_${idx}`,
    text: p.text || p.content || p.narration || '',
    shotId: p.shotId,
    duration: p.duration,
    emotion: p.emotion || '',
    /** 🎭 P1 角色组合匹配：透传步骤3 生成的角色名单，供爆破切分器子句继承 */
    characters: Array.isArray(p.characters) ? p.characters
      : (Array.isArray(p.anchoredCharacters) ? p.anchoredCharacters : undefined),
    /** 🎯 P3 画面意图：透传步骤3 生成的画面意图描述，供爆破切分器子句继承 */
    visualIntent: p.visualIntent || '',
    /** 🎯 P3 时间轴锚定：透传对应 chunk 的时间起点/时长（ms），供步骤5 锚定切片 */
    startMs: p.startMs,
    durationMs: p.durationMs,
    /** 🎯 匹配单位：透传步骤3 断句器写入的「完整句」id（sentence 档才有，legacy 档为 undefined） */
    matchUnitId: p.matchUnitId,
    /** 🎙️ 原声保留段判别信息透传：缺失时 Normalizer 会把原声段误判为解说段，
     *  写后显示成带引号的普通文案且无「原声保留」标签（须重进才恢复）。 */
    type: p.type,
    keepOriginalAudio: p.keepOriginalAudio === true,
    audioSource: p.audioSource,
    /** 原始顺序号：非原声段断句后与原声段按此合并，保持与生成顺序一致 */
    __order: idx,
  }));
  // 🎙️ 分离原声段：原声段整段保留（断句会破坏原台词定位），仅解说段走断句器，再按 __order 合并
  const originalAudioPara = rawParagraphs.filter(
    (p: any) => p.type === 'original_audio' || p.keepOriginalAudio || p.audioSource,
  );
  const narrationOnlyPara = rawParagraphs.filter(
    (p: any) => !(p.type === 'original_audio' || p.keepOriginalAudio || p.audioSource),
  );
  const mergedPara = [...breakLongParagraphs(narrationOnlyPara, { matchUnit: resolveScriptMatchUnitMode() }), ...originalAudioPara]
    .sort((a: any, b: any) => (a.__order ?? 0) - (b.__order ?? 0));
  // 爆破切分器拆分超长段落后，统一过 Normalizer 净化为判别联合契约
  // （补齐 type / 毫秒时间轴，editing 布尔由 Normalizer narration 分支透传保留）
  const newParagraphs = mergedPara.map(
    (p) => normalizeScriptParagraph({ ...p, editing: false })
  );
  // 🛑 空产物按失败处理：不得沿用旧文案后仍置 completed / commit 新版本
  if (newParagraphs.length === 0) {
    throw new Error('文案生成结果为空，已保留上一次文案');
  }
  const diffs = diffParagraphs(previousParagraphs, newParagraphs);
  useStep3Store.getState().setScriptParagraphs(applyDiffUpdate(previousParagraphs, diffs));
}

// ── 各步骤差异（payload / 前置校验 / 后处理），三处入口共用 ──
const STEP_DEFS: Record<RunnableStep, StepDef> = {
  2: {
    id: 2,
    guard: () => {
      const project = useProjectStore.getState();
      // 🛑 修复「步骤2 失败后重试被误报『请先完成步骤1』」：
      //   步骤2 失败时上游可能把 extractedData.framePaths 清空（帧回写为空结果的 bug），
      //   导致这里拦死整条管线。先从媒体素材自带的 frames 自愈，真正无帧才阻断。
      let existingFrames = project.extractedData?.framePaths || [];
      if (existingFrames.length === 0) {
        const fromMedia = (project.mediaItems || [])
          .flatMap((m: any) => (Array.isArray(m?.frames) ? m.frames : []))
          .map((f: any) => (typeof f === 'string' ? f : (f?.path ?? f?.filePath ?? f?.url ?? f?.thumbnail ?? '')))
          .filter((p: any) => typeof p === 'string' && p.trim().length > 0);
        if (fromMedia.length > 0) {
          useProjectStore.getState().setExtractedData({
            framePaths: fromMedia,
            frameCount: fromMedia.length,
          });
          existingFrames = fromMedia;
          AppNotifier.info(`已从素材缓存恢复 ${fromMedia.length} 张关键帧，继续执行画面描述`);
        }
      }
      if (existingFrames.length === 0) {
        return '关键帧列表为空，请先在步骤1「素材分析」完成抽帧，再执行画面描述';
      }
      if (!project.mediaItems?.[0]?.filePath) {
        throw new AppError(ErrorCode.FS_FILE_NOT_FOUND, '未找到媒体文件路径');
      }
      return null;
    },
    buildParams: () => {
      const project = useProjectStore.getState();
      const step1 = useStep1Store.getState();
      const media = project.mediaItems?.[0];
      return {
        mediaPath: media?.filePath || '',
        mediaId: media?.id || '',
        framePaths: project.extractedData?.framePaths || [],
        // 🎬 帧真实时间戳（源坐标，与 framePaths 顺序对齐）：step2 用真实时间轴匹配 ASR 台词，
        //   替代旧版 estimatedInterval 估算（fi × 平均间隔），修复 vlmFrames.asrText 系统性错位
        frameTimeMs: project.extractedData?.frameTimeMs || [],
        projectId: project.projectId,
        matrixMode: step1.extractionConfig?.frames?.matrixMode || 'auto',
        audioResult: {
          lines: step1.asrLines || [],
        },
        // 🎭 注入 roles：让 step2 VLM 描述时使用人物名称（来自 step1 人脸识别结果）
        roles: project.roles || [],
      };
    },
    isEmpty: (raw) => isStepProductEmpty(2, raw),
    missingMessage: '管线未返回结果',
    emptyMessage: '步骤2产物为空，已保留上一次有效结果',
    failureMessage: '步骤执行失败',
  },
  3: {
    id: 3,
    before: () => {
      const previousParagraphs = useStep3Store.getState().scriptParagraphs;
      // 🔧 重新生成前先清空旧文案：避免旧文案残留显示；
      //    🛡️ 失败时由快照恢复旧文案（旧文案本已持久化，失败不该抹掉用户已有内容）。
      useStep3Store.getState().setScriptParagraphs([]);
      return { previousParagraphs };
    },
    buildParams: () => {
      const project = useProjectStore.getState();
      const step1 = useStep1Store.getState();
      const step2 = useStep2Store.getState();
      const step3 = useStep3Store.getState();
      const media = project.mediaItems?.[0];
      return {
        mediaPath: media?.filePath || '',
        mediaId: media?.id || '',
        scriptStyle: step3.scriptStyle || '爆款短视频',
        speechRate: step3.speechRate || 4.5,
        pipelineParams: step3.pipelineParams,
        /** 🎭 风格包（人格 × 浓度）：后端拼接人格指令与禁用词，只改语体 */
        stylePack: step3.stylePack,
        visionResult: {
          sceneDescriptions: step2.vlmFrames
            ?.map((f: any) => f.description || '')
            .filter(Boolean)
            .join('\n') || '',
          // 🎭 P0 修复：透传 vlmFrames 完整数据（含 downstream 结构化字段），
          // 让 ScriptGenStrategy 可消费 downstreamContext.shots 优化路径
          frames: step2.vlmFrames || [],
        },
        audioResult: {
          lines: step1.asrLines || [],
        },
        // 🎭 P0 修复：注入 roles 人物角色列表，让 step3 生成解说时使用统一人物名称
        // 数据源用 projectState.roles（hydrate 后的统一来源，含用户手动改名后的最新值）
        roles: project.roles || [],
      };
    },
    finalize: (raw, _ctx, runState) => {
      const previousParagraphs = (runState as { previousParagraphs?: any[] } | undefined)?.previousParagraphs || [];
      finalizeStep3(raw, previousParagraphs);
    },
    isEmpty: (raw) => isStepProductEmpty(3, raw),
    missingMessage: '文案生成未返回结果，已保留上一次文案',
    emptyMessage: '文案生成结果为空，已保留上一次文案',
    failureMessage: '文案生成失败',
  },
  4: {
    id: 4,
    before: () => {
      // 合成前主动清空历史 TTS 结果与进度，避免残留旧数据（含试听/上次失败产物）被误匹配播放
      useStep4Store.getState().setTtsResults([]);
      useStep4Store.getState().setTtsProgress(0);
    },
    buildParams: (ctx) => {
      const project = useProjectStore.getState();
      const step3 = useStep3Store.getState();
      const step4 = useStep4Store.getState();
      const media = project.mediaItems?.[0];
      const overrides = ctx.uiOverrides ?? {};
      return {
        ttsEngine: overrides.ttsEngine || step4.ttsEngine || 'edge',
        ttsVoiceId: overrides.ttsVoiceId || step4.ttsVoiceId || '',
        voiceId: overrides.voiceId || overrides.ttsVoiceId || step4.ttsVoiceId || '',
        /** 步骤4 合成语速：以 store 为准（跨会话稳定），入口显式覆盖时才用 override */
        speechRate: typeof overrides.speechRate === 'number' ? overrides.speechRate : (step4.speechRate ?? 1.0),
        /** 🎭 句尾停顿（ms）：随风格包配置，仅 Edge 生效 */
        pauseMs: step4.pauseMs,
        mediaPath: media?.filePath || '',
        mediaId: media?.id || '',
        scriptShots: step3.scriptParagraphs || [],
      };
    },
    isEmpty: (raw) => isStepProductEmpty(4, raw),
    missingMessage: '配音合成未返回结果，已保留上一次配音',
    emptyMessage: '配音合成结果为空，已保留上一次配音',
    failureMessage: '配音合成失败',
  },
  5: {
    id: 5,
    before: () => {
      const step5 = useStep5Store.getState();
      /** 🔒 K2 锚定冻结：重匹配前快照用户手动锁定(iUserLocked)的切片，结果返回后原样恢复，
       *  使手调工作不被全局 Beam 重算冲垮；未锁定的节点照常参与全新匹配。 */
      const lockedSnapshot = new Map(
        step5.matchResults
          .filter((m: any) => m.isUserLocked)
          .map((m: any) => [m.id, m])
      );
      /** 🔧 新匹配开始：清空上一次匹配诊断（避免旧 warning 残留，等新结果返回再写入）；
       *  🛡️ 失败时由快照恢复旧诊断 */
      step5.setMatchDiagnostics(null);
      return { lockedSnapshot };
    },
    buildParams: () => {
      const project = useProjectStore.getState();
      const step1 = useStep1Store.getState();
      const step2 = useStep2Store.getState();
      const step3 = useStep3Store.getState();
      const step4 = useStep4Store.getState();
      const step5 = useStep5Store.getState();
      const media = project.mediaItems?.[0];
      return {
        mediaPath: media?.filePath || '',
        /** 🎬 素材 id 必传（2026-09-04）：OP/ED 裁剪配置按素材 id 存于 projects.extraction_config.mediaTrim.perMedia，
         *  缺 mediaId → resolveForMedia 解析不到 trim → needTrim=false → 方向3 直接复用历史"全片含片头"切片池，
         *  导致片头/出品帧始终进匹配与导出（"改了没变"的根因）。补齐后走正剧(body)切片。 */
        mediaId: media?.id || (media as any)?.assetId || '',
        /** 🎬 切片池复用（方向3）：回传本项目已保存的切片池（上次步骤5 结果），后端优先复用免重切。 */
        videoChunks: step5.videoChunks || [],
        scriptShots: step3.scriptParagraphs || [],
        ttsDurations: step4.ttsResults || [],
        /** ASR 原声时间轴：原声段落（keepOriginalAudio）按原声文本定位原片时间段 */
        asrLines: step1.asrLines || [],
        /** 步骤2 逐帧 VLM 描述（带时间戳）：整帧原样透传，禁止在本层裁剪字段 */
        visionResult: {
          sceneDescriptions: step2.vlmFrames
            ?.map((f: any) => f.description || '')
            .filter(Boolean)
            .join('\n') || '',
          frames: step2.vlmFrames || [],
        },
        bgmInfo: step5.activeBgm ?? null,
      };
    },
    finalize: (raw, _ctx, runState) => {
      mapPipelineResultToState(raw, buildMappers());
      const lockedSnapshot = (runState as { lockedSnapshot?: Map<string, any> } | undefined)?.lockedSnapshot;
      /** 🔒 K2 锚定冻结恢复：全局重算结果里，被锁定节点按快照原样还原（含所选切片/裁点/变速/确认态），
       *  其余节点保留新匹配结果——既有锚点不可变更，只让非锁定段吸收差异。 */
      if (lockedSnapshot && lockedSnapshot.size > 0) {
        const cur = useStep5Store.getState().matchResults;
        const restored = cur.map((m: any) => (lockedSnapshot.has(m.id) ? { ...lockedSnapshot.get(m.id) } : m));
        useStep5Store.getState().setMatchResults(restored);
      }
    },
    isEmpty: (raw) => isStepProductEmpty(5, raw),
    missingMessage: '镜头匹配未返回结果，已保留上一次匹配',
    emptyMessage: '镜头匹配结果为空，已保留上一次匹配',
    failureMessage: '匹配失败',
  },
};

/**
 * 执行单个步骤（步骤2~5）。
 *
 * 所有入口（orchestrator.executeStep、步骤3/4/5 Container）都只调用本函数；
 * 用户可见行为由 STEP_DEFS 决定，不再分散在各入口。
 */
export async function runStep(step: number, opts: StepRunOptions = {}): Promise<StepRunResult> {
  const def = STEP_DEFS[step as RunnableStep];
  if (!def) {
    return { status: 'failed', step: step as RunnableStep, error: `步骤 ${step} 未配置管线节点` };
  }

  const projectState = useProjectStore.getState();
  const ps = usePipelineStore.getState();
  if (!projectState.projectId) {
    return { status: 'skipped', step: def.id, skippedReason: '项目未加载' };
  }

  // 🔧 步骤2-5已完成的跳过逻辑
  // 仅在【自动流水线自动前进】时（force=false），已完成且产物版本有效时才跳到下一步。
  // 阶段4：过期/未验证/legacy 产物不得跳过——否则「completed + 旧产物」会绕过重算，
  // 产出新上游 + 旧下游的错片。用户主动启动（force=true）仍然强制重新执行。
  const autoSkipKey = String(def.id) as ArtifactKey;
  if (
    !opts.force
    && useEditorNavStore.getState().isAutoMode
    && ps.stepStatuses[def.id - 1] === 'completed'
    && def.id < 5
    && isStepArtifactValid(autoSkipKey)
  ) {
    AppNotifier.info(`步骤${def.id}已完成，跳转至下一步`);
    useEditorNavStore.getState().setCurrentStep(def.id + 1);
    return { status: 'skipped', step: def.id, skippedReason: '已完成' };
  }

  // 🎫 每次执行独立 token：中止只影响本次执行，旧任务无法在新一轮里继续写库
  const runToken = createRunToken();
  currentRunToken = runToken;

  // 🔧 先清理上次管线的进度/错误瞬态，再设置 running 状态
  // 旧版 bug：resetPipeline() 在 setPipelineRunning(true) 之后调用，
  //          内部 set({ pipelineRunning: false }) 把刚设的 true 覆盖回 false
  ps.resetPipeline();
  ps.setStepStatus(def.id, 'running');
  ps.setPipelineRunning(true);
  editorLogger.trackStep(def.id, 'start', { projectId: projectState.projectId });

  // 🛡️ 先快照上一次可用结果，失败/中止时恢复（不能抹掉用户已完成的成片数据）
  const snapshot = capturePipelineDataSnapshot();
  const ctx: StepRunContext = {
    step: def.id,
    projectId: projectState.projectId,
    force: !!opts.force,
    uiOverrides: opts.uiOverrides,
    snapshot,
  };

  const finishAborted = async (handle: StepRunHandle | null): Promise<StepRunResult> => {
    if (handle) await abortStepRun(handle);
    // 中止同样不丢数据（I3）：恢复执行前快照，但版本保持 valid=false
    restorePipelineDataSnapshot(snapshot);
    ps.setStepStatus(def.id, 'idle');
    ps.setPipelineRunning(false);
    finishRun(runToken);
    return { status: 'aborted', step: def.id };
  };

  let handle: StepRunHandle | null = null;

  try {
    // 前置校验放在 begin 之前：被阻断时不产生版本变更
    const blockReason = def.guard?.(ctx);
    if (blockReason) {
      ps.setStepStatus(def.id, 'idle');
      ps.setPipelineRunning(false);
      finishRun(runToken);
      AppNotifier.warning(blockReason);
      return { status: 'skipped', step: def.id, skippedReason: blockReason };
    }

    // 🛑 P0：进入实际执行前级联失效下游结果与完成标记。
    //   先冻结输入指纹（beginStepRun），再清数据，保证 fromKey 记录的是执行开始时的上游状态。
    handle = await beginStepRun(String(def.id) as ArtifactKey);
    if (isRunAborted(runToken)) return finishAborted(handle);
    invalidateDownstreamSteps(def.id);

    const runState = def.before?.(ctx);

    const sequence = STEP_SEQUENCES[def.id];
    if (!sequence) {
      throw new Error(`步骤 ${def.id} 未配置管线节点`);
    }
    const media = useProjectStore.getState().mediaItems?.[0];
    const enrichedSequence = sequence.map((node: any) => ({
      ...node,
      params: {
        ...(node.params || {}),
        ...def.buildParams(ctx, node),
      },
    }));

    const result = await API.engine.runPipeline({
      projectId: projectState.projectId,
      sequence: enrichedSequence,
      sourceMedia: media?.filePath || '',
    });

    // 🛑 用户已中止：后端可能返回被截断的结果，绝不能当成成功写入 / 标记完成
    if (isRunAborted(runToken)) return finishAborted(handle);
    if (!result) {
      throw new Error(def.missingMessage);
    }
    const rawResult = result?.data || result;
    // 🛑 空产物按失败处理：MATCH 等映射在空结果时会保留旧值，
    //   若继续置 completed/commit，会把旧数据认证为新结果。
    if (def.isEmpty(rawResult)) {
      throw new Error(def.emptyMessage);
    }
    if (def.finalize) {
      def.finalize(rawResult, ctx, runState);
    } else {
      mapPipelineResultToState(rawResult, buildMappers());
    }
    // 产物非空且映射完成 → 提交新版本（rev+1, valid=true）
    await commitArtifacts(handle);

    ps.setStepCompleted(def.id, true);
    ps.setStepStatus(def.id, 'completed');
    editorLogger.trackStep(def.id, 'complete');

    try {
      // ✅ 统一走公共落盘入口：产物与 artifactStamps 同批写入
      await persistProjectSnapshot(projectState.projectId);
    } catch (saveErr) {
      console.error(`[步骤${def.id}] 完工落盘失败:`, saveErr);
    }

    finishRun(runToken);
    ps.setPipelineRunning(false);
    return { status: 'completed', step: def.id };
  } catch (err: any) {
    // 🛑 用户中止导致的 reject 不是失败：静默收尾，不弹错误条
    if (isRunAborted(runToken)) return finishAborted(handle);
    if (handle) await failStepRun(handle);
    ps.setStepStatus(def.id, 'failed');
    ps.setPipelineError(err?.message || def.failureMessage);
    ps.setPipelineRunning(false);
    // 🛡️ 把执行前快照的数据放回（数据回来了，但完成标记不回，用户需重跑失败步骤）
    restorePipelineDataSnapshot(snapshot);
    finishRun(runToken);
    return { status: 'failed', step: def.id, error: err?.message || def.failureMessage };
  }
}
