// Module: pipeline/step1-material - OpEdTrimConfig
// 🎬 最终版 OP/ED 片头片尾裁剪落地 UI 总成：
//   1) 手动配置（trimStart/trimEnd 秒数输入框 + 手动锁定开关）
//   2) 自动识别按钮：跑 P1 黑场静音启发 → P2 跨集指纹对齐 两级编排；识别置信不足时结果仅进"待确认建议"，并透出 P1 Top3 候选时间点供一键采纳
//   3) 建议历史：每条来源(P1/P2/USER_MANUAL)、值、置信度、是否被采纳、时间戳、「✅ 接受建议」按钮
//   4) 实时状态（锁定时自动结果不再覆盖，并显示锁图标）
//
// 设计取舍：不引入 P3 VLM 自动兜底——识别不可靠的场景直接交给用户手动选择（候选点一键采纳 / 手动输入 + 锁定）。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IPC_CHANNELS } from "@modules/infra/ipc/IpcConstants";
import {
  Scissors,
  Wand2,
  Check,
  History,
  Sparkles,
  Fingerprint,
  User,
  ChevronDown,
  ChevronUp,
  Loader2,
  AlertCircle,
  X,
  Play,
} from 'lucide-react';
import { useStep1Store } from '@modules/pipeline/stores/useStep1Store';
import { Badge } from '@renderer/components/shared';
import type { DetectionSource } from '../../../../../main/engine/utils/MediaTrimPolicy';

interface OpEdTrimConfigProps {
  projectId: string;
  mediaId: string;
  mediaName?: string;
  durationMs?: number;
  sourcePath?: string;
  onJumpVideoMs?: (ms: number) => void;
}

interface OpedState {
  trim: { trimStartMs: number; trimEndMs: number };
  history: Array<{
    source: DetectionSource;
    trimStartMs: number;
    trimEndMs: number;
    confidence: number;
    createdAt: string;
    note?: string;
    anchorMediaId?: string;
    adopted?: boolean;
  }>;
}

const SOURCE_META: Record<DetectionSource, { label: string; short: string; Icon: any; cls: string }> = {
  USER_MANUAL:       { label: '用户手动',   short: '用户',   Icon: User,        cls: 'bg-accent/15 text-accent border-accent/30' },
  P2_CHROMAPRINT_ALIGN: { label: 'P2 跨集指纹对齐', short: 'P2 指纹', Icon: Fingerprint, cls: 'bg-indigo-500/15 text-indigo-500 border-indigo-500/30' },
  P1_FFMPEG_HEURISTIC: { label: 'P1 黑场+静音启发', short: 'P1 音视频', Icon: Sparkles, cls: 'bg-accent-green/15 text-accent-green border-accent-green/30' },
};

/** 🎞 帧率：与播放器 formatTimecode 保持一致固定 30fps（帧号 0-29） */
const TC_FPS = 30;

/**
 * 🕐 毫秒 → **HH:MM:SS:FF（时:分:秒:帧）4 段式 SMPTE 时间码**
 * 与播放器 [PlayerControls.tsx#L16-L23] formatTimecode 实现**完全一致**：
 *   0ms        → "00:00:00:00"
 *   85_000ms   → "00:01:25:00"  （1分25秒第0帧）
 *   65_300ms   → "00:01:05:09"  （1分5秒 0.3s×30fps=第9帧）
 *   7385_000ms → "02:03:05:00"  （超 1 小时正常进位）
 */
const fmtMs = (ms: number): string => {
  if (!ms || ms <= 0) return '00:00:00:00';
  const sec = ms / 1000;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const f = Math.floor((sec % 1) * TC_FPS); // 0.3s ×30fps = 9 帧
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}:${f.toString().padStart(2, '0')}`;
};

/**
 * 🕐 反向：用户输入字符串 → 秒数（支持 **9 种写法自由混合**，怎么顺手怎么填）
 * 【时间码格式（与播放器一致，推荐）】
 *   "00:01:25:00" → 85     （4段 · 标准 SMPTE 时:分:秒:帧）
 *   "01:25:09"    → 85.3   （3段省略小时 · 按最后一段≤29判定为帧号，0.3s=第9帧）
 * 【简写格式（省帧位，日常够用）】
 *   "01:25"       → 85     （2段 · 分:秒，不写帧=帧0）
 *   "1:25"        → 85     （2段不补 0 也行，解析不要求对齐 2 位数）
 *   "01:05.3"     → 65.3   （2段带 .x 小数秒 · 直接当秒小数，与帧等价）
 * 【兜底格式（不用切换输入法）】
 *   "85"          → 85     （纯数字 = 秒数，兼容老习惯）
 *   "1分25秒"     → 85     （中文单位）
 *   "1m25s"       → 85     （英文单位）
 *   "" / "0"      → 0
 * 解析失败返回 NaN，调用方用 !isFinite 判
 */
const parseTimeStr = (raw: string): number => {
  if (!raw) return 0;
  const s = String(raw).trim();
  if (!s) return 0;

  // ① 冒号分段时间码（优先匹配：4段=HH:MM:SS:FF / 3段=智能判帧 / 2段=MM:SS）
  if (/^\d{1,2}(:\d{1,2}){1,3}(\.\d+)?$/.test(s)) {
    const parts = s.split(':').map(p => p); // 保留原样字符串方便小数段
    const hasDot = parts.some(p => p.includes('.'));
    if (parts.length === 4) {
      // ✅ 标准 4 段：HH:MM:SS:FF（最后一段 = 帧号 0-29）
      const [h, m, sec, fStr] = parts;
      const f = parseInt(fStr, 10) || 0;
      return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(sec, 10) + f / TC_FPS;
    }
    if (parts.length === 3) {
      // 3 段歧义判定：
      //  · 如果任意段带小数 → 当成 HH:MM:SS（小时省略不写帧的写法，如 1:02:03.5）
      //  · 否则最后一段 ≤29（帧号范围）→ 当成 MM:SS:FF（省略 HH 的帧时间码）
      //  · 否则最后一段 ≥30 → 当成 HH:MM:SS（秒号不可能<0/≥60，帧号只到29）
      if (hasDot) {
        const [h, m, secX] = parts;
        return parseFloat(h) * 3600 + parseFloat(m) * 60 + parseFloat(secX);
      }
      const last = parseInt(parts[2], 10);
      if (!isNaN(last) && last <= TC_FPS - 1) {
        // MM:SS:FF（省略小时）
        const [m, sec, fStr] = parts;
        return parseInt(m, 10) * 60 + parseInt(sec, 10) + (parseInt(fStr, 10) || 0) / TC_FPS;
      } else {
        // HH:MM:SS（无帧）
        const [h, m, sec] = parts;
        return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(sec, 10);
      }
    }
    // 2 段：MM:SS[.x] 或 MM:SS[.x]（mm:ss 补零与否都可）
    const [m, secX] = parts;
    return parseFloat(m) * 60 + parseFloat(secX);
  }

  // ② 中文单位："1分25秒" / "1分" / "25秒"
  const cn = s.match(/^(\d+(?:\.\d+)?)分?(\d+(?:\.\d+)?)?秒?$/);
  if (cn) {
    const minPart = parseFloat(cn[1] || '0');
    const secPart = parseFloat(cn[2] || '0');
    if (s.includes('分')) return minPart * 60 + secPart;
    return secPart || minPart;
  }
  // ③ 英文单位："1m25s" / "1m" / "25s"
  const en = s.match(/^(\d+(?:\.\d+)?)m(\d+(?:\.\d+)?)?s?$/);
  if (en) {
    const minPart = parseFloat(en[1] || '0');
    const secPart = parseFloat(en[2] || '0');
    if (s.includes('m')) return minPart * 60 + secPart;
    return secPart || minPart;
  }
  // ④ 纯数字兜底 → 秒数
  const pure = parseFloat(s);
  if (isFinite(pure)) return pure;
  return NaN;
};

const fmtConf = (c: number) => `${Math.round((c || 0) * 100)}%`;

export const OpEdTrimConfig: React.FC<OpEdTrimConfigProps> = ({ projectId, mediaId, mediaName: _mediaName, durationMs, sourcePath, onJumpVideoMs }) => {
  const [state, setState] = useState<OpedState>({ trim: { trimStartMs: 0, trimEndMs: 0 }, history: [] });
  // 🎚 双滑块：轨道引用 + 拖动状态（拖动用 ref + window 级监听，不依赖 pointer capture，松手只保存一次）
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragKind, setDragKind] = useState<'start' | 'end' | null>(null);
  const [dragSec, setDragSec] = useState<number | null>(null);
  const dragStateRef = useRef<{ kind: 'start' | 'end'; sec: number } | null>(null);
  const [loadingState, setLoadingState] = useState(false);
  const [runningDetect, setRunningDetect] = useState(false);
  const [lastDetectError, setLastDetectError] = useState<string | null>(null);
  // ℹ️ 自动识别状态单行提示（收敛原终端式日志）
  const [detectStatus, setDetectStatus] = useState<{ kind: 'running' | 'ok' | 'warn' | 'error'; text: string } | null>(null);
  // 🔮 识别预览：自动识别结果先落到双柄滑块上供用户直接查看/微调；拖动/采纳/保存后写库并清除
  const [pendingTrim, setPendingTrim] = useState<{ trimStartMs: number; trimEndMs: number } | null>(null);
  // ✅ P1 Top3 候选时间点（识别置信不足时作为轨道锚点，点击即采纳）
  const [opCandidates, setOpCandidates] = useState<Array<{ sec: number; score: number }>>([]);
  const [edCandidates, setEdCandidates] = useState<Array<{ sec: number; score: number }>>([]);
  const [trimStartSecInput, setTrimStartSecInput] = useState('0');
  const [trimEndSecInput, setTrimEndSecInput] = useState('0');
  const [expandedHistory, setExpandedHistory] = useState(false);
  const _updateExtractionConfig = useStep1Store((s) => s.updateExtractionConfig);

  /** 素材路径：优先用 props 传入的 sourcePath，必要时做 magicPath 还原；仅用于给后端 Python 传递绝对路径跑 FFmpeg 检测 */
  const mediaPath = sourcePath || '';

  /** 🎯 读状态：从 IPC 读当前素材的 OP/ED 配置与历史（回填输入框用 mm:ss 分秒格式，和播放器时间码一致） */
  const reloadState = useCallback(async () => {
    if (!projectId || !mediaId) return;
    setLoadingState(true);
    try {
      const r = await (window as any).api?.invoke?.(IPC_CHANNELS.OPED_GET_STATE, projectId, mediaId);
      if (r?.ok && r?.data) {
        setState(r.data as OpedState);
        // ✅ 直接用 mm:ss 格式回填（如 85000ms → "1:25"），用户一看就懂
        setTrimStartSecInput(fmtMs(r.data.trim.trimStartMs || 0));
        setTrimEndSecInput(fmtMs(r.data.trim.trimEndMs || 0));
      }
      // 回到库真值即退出识别预览（未确认的识别结果不残留）
      setPendingTrim(null);
    } finally { setLoadingState(false); }
  }, [projectId, mediaId]);

  useEffect(() => { reloadState(); }, [reloadState]);

  /** 🔍 按钮：跑完整 P1→P2 自动识别编排；结果统一落回双柄滑块（低置信时预置最佳候选），候选点作轨道锚点，日志收敛为单行状态 */
  const runDetect = useCallback(async () => {
    if (!projectId || !mediaId || !mediaPath) { alert('请先选择一个视频素材'); return; }
    setRunningDetect(true);
    setLastDetectError(null);
    setOpCandidates([]);
    setEdCandidates([]);
    setDetectStatus({ kind: 'running', text: '正在自动识别 OP/ED…' });
    try {
      const r = await (window as any).api?.invoke?.(IPC_CHANNELS.OPED_RUN_DETECT, projectId, mediaId, mediaPath);
      if (!r?.ok) throw new Error(r?.error || 'invoke fail');
      const data = r.data as any;
      // ✅ 从 P1 步骤透出 Top3 候选时间点（识别不可靠时作轨道锚点，点击即采纳）
      const p1Step = (data.steps || []).find((s: any) => s.source === 'P1_FFMPEG_HEURISTIC');
      const opCands: Array<{ sec: number; score: number }> = (p1Step?.opCandidates as any[]) || [];
      const edCands: Array<{ sec: number; score: number }> = (p1Step?.edCandidates as any[]) || [];
      setOpCandidates(opCands);
      setEdCandidates(edCands);
      // 先回到库真值，再决定是否落识别预览
      await reloadState();
      const finalStart = data.finalTrim?.trimStartMs || 0;
      const finalEnd = data.finalTrim?.trimEndMs || 0;
      const totalSec = (durationMs && durationMs > 0 ? durationMs : 0) / 1000;
      if (data.written && !data.isLockedAfter && (opCands.length || edCands.length)) {
        // 🔮 低置信/不确定：把最佳候选预置到双柄滑块，用户直接查看并在轨道上微调（松手或点锚点后写库）
        const bestOp = opCands.length ? opCands.reduce((a, b) => (b.score > a.score ? b : a)).sec : (finalStart / 1000);
        const bestEd = edCands.length ? edCands.reduce((a, b) => (b.score > a.score ? b : a)).sec : 0;
        setPendingTrim({
          trimStartMs: Math.round(bestOp * 1000),
          // 候选 ED 秒数换算成尾部裁剪量：trimEndMs = (总时长 - 候选秒) * 1000
          trimEndMs: bestEd > 0 ? Math.max(0, Math.round((totalSec - bestEd) * 1000)) : finalEnd,
        });
        setDetectStatus({
          kind: 'warn',
          text: `识别不确定，已预置候选：OP≈${fmtMs(Math.round(bestOp * 1000))} / ED≈${fmtMs(bestEd > 0 ? Math.round(bestEd * 1000) : finalEnd)}，可直接拖动微调或点下方候选点采纳`,
        });
      } else if (data.written) {
        // 高置信或已有手动锁：识别结果已落库生效，滑块随 reload 回填
        setDetectStatus({ kind: 'ok', text: `已识别并生效：OP ${fmtMs(finalStart)} / ED ${fmtMs(finalEnd)}，可拖动微调` });
      } else {
        setDetectStatus({ kind: 'error', text: `写入失败：${data.writeError || 'unknown'}` });
      }
      // 同步刷新 Step1Store 的 extractionConfig，让用户立即看到生效的 mediaTrim（UI 不卡刷新）
      try {
        _updateExtractionConfig({ mediaTrim: data.finalConfig || {} });
      } catch {}
    } catch (e: any) {
      setLastDetectError(e.message || String(e));
      setDetectStatus({ kind: 'error', text: `识别失败：${e.message || String(e)}` });
    } finally { setRunningDetect(false); }
  }, [projectId, mediaId, mediaPath, durationMs, reloadState, _updateExtractionConfig]);

  /** ✅ 接受某条历史建议（以用户身份写入并隐式锁定） */
  const acceptHistory = useCallback(async (index: number) => {
    if (!projectId || !mediaId) return;
    const r = await (window as any).api?.invoke?.(IPC_CHANNELS.OPED_ACCEPT_SUGGESTION, projectId, mediaId, index, 'ui');
    if (r?.ok) {
      setPendingTrim(null); // 已写库，退出识别预览
      await reloadState();
    } else {
      alert('接受建议失败: ' + (r?.error || 'unknown'));
    }
  }, [projectId, mediaId, reloadState]);

  /** 💾 提交手动裁剪值（滑块 / 输入框共用入口，USER_MANUAL 身份写入并开手动锁） */
  const commitManual = useCallback(async (startSec: number, endSec: number) => {
    if (!projectId || !mediaId) return;
    if (!isFinite(startSec) || startSec < 0) startSec = 0;
    if (!isFinite(endSec) || endSec < 0) endSec = 0;
    // 校验：保留区间必须为正（片头裁剪量 + 片尾裁剪量 < 总时长）
    const totalSec = (durationMs && durationMs > 0 ? durationMs : 0) / 1000;
    if (totalSec > 0 && startSec + endSec >= totalSec - 0.25) { alert('保留区间不能为空'); return; }
    const startMs = Math.round(startSec * 1000);
    const endMs = Math.round(endSec * 1000);
    const payload: any = { trimStartMs: startMs, trimEndMs: endMs, confidence: 1, note: `用户手动保存：OP ${fmtMs(startMs)} / ED ${fmtMs(endMs)}` };
    const r = await (window as any).api?.invoke?.(IPC_CHANNELS.OPED_ACCEPT_SUGGESTION, projectId, mediaId, payload, 'ui');
    if (r?.ok) {
      setPendingTrim(null); // 已写库，退出识别预览
      await reloadState();
    }
    else alert('保存失败: ' + (r?.error || 'unknown'));
  }, [projectId, mediaId, durationMs, reloadState]);

  /** 💾 输入框保存（fallback：无时长信息时不显示滑块） */
  const saveManualTrim = useCallback(async () => {
    if (!projectId || !mediaId) return;
    const startSec = parseTimeStr(trimStartSecInput);
    const endSec = parseTimeStr(trimEndSecInput);
    if (!isFinite(startSec) || startSec < 0) { alert(`片头裁剪时间无法解析：「${trimStartSecInput}」`); return; }
    if (!isFinite(endSec) || endSec < 0) { alert(`片尾裁剪时间无法解析：「${trimEndSecInput}」`); return; }
    await commitManual(startSec, endSec);
  }, [projectId, mediaId, trimStartSecInput, trimEndSecInput, commitManual]);

  /** 🎚 滑块：左柄(绿)=片头裁剪点从左往右 / 右柄(黄)=片尾从右往左（右柄轨道位置=正剧结束点），松手保存一次 */
  const durationSec = (durationMs && durationMs > 0 ? durationMs : 0) / 1000;
  // 🔮 识别预览优先于已生效值：自动识别（含低置信预置）先展示在滑块上，确认写库后切回库真值
  const activeTrim = pendingTrim ?? state.trim;
  const startSecBase = (activeTrim.trimStartMs || 0) / 1000;                 // 左柄轨道位置 = 片头裁剪量
  const endPosBase = durationSec - (activeTrim.trimEndMs || 0) / 1000;       // 右柄轨道位置 = 正剧结束点（未裁=最右端，左拖=裁尾）
  const startPosPreview = dragKind === 'start' && dragSec != null ? dragSec : startSecBase;
  const endPosPreview = dragKind === 'end' && dragSec != null ? dragSec : endPosBase;
  const pctOf = (sec: number) => (durationSec > 0 ? Math.min(100, Math.max(0, (sec / durationSec) * 100)) : 0);
  // 合法区间：保留最小 0.5s（拖动中直接 clamp，不产生回弹）
  const clampStart = (sec: number) => Math.min(Math.max(0, sec), Math.max(0, endPosBase - 0.5));
  const clampEnd = (sec: number) => Math.min(durationSec, Math.max(startSecBase + 0.5, sec));

  const handleTrackDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (durationSec <= 0) return;
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const t = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const clickSec = t * durationSec;
    const kind: 'start' | 'end' = Math.abs(clickSec - startSecBase) <= Math.abs(clickSec - endPosBase) ? 'start' : 'end';
    const sec = kind === 'start' ? clampStart(clickSec) : clampEnd(clickSec);
    dragStateRef.current = { kind, sec };
    setDragKind(kind);
    setDragSec(sec);
    e.preventDefault();
  };

  // 🎬 拖动中实时预览 seek：节流（~120ms）避免高频 seek 卡顿；force=true 用于松手补跳最终点
  const lastSeekAtRef = useRef(0);
  const seekPreview = useCallback((sec: number, force = false) => {
    if (!onJumpVideoMs) return;
    const now = Date.now();
    if (!force && now - lastSeekAtRef.current < 120) return;
    lastSeekAtRef.current = now;
    // 两柄的轨道位置即预览目标：左柄=片头裁剪点、右柄=正剧结束点（ED 开始点），直接用轨道位置跳转，勿再按裁剪量换算
    onJumpVideoMs(Math.round(sec * 1000));
  }, [onJumpVideoMs]);

  // window 级监听：指针移出轨道也能继续拖动、松手必定触发，且 pointerup 只保存一次
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const st = dragStateRef.current;
      const el = trackRef.current;
      if (!st || !el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const t = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const sec = st.kind === 'start' ? clampStart(t * durationSec) : clampEnd(t * durationSec);
      st.sec = sec;
      setDragSec(sec);
      seekPreview(sec); // 拖动即联动画面
    };
    const up = async () => {
      const st = dragStateRef.current;
      dragStateRef.current = null;
      if (!st) return;
      setDragKind(null);
      setDragSec(null);
      // 位置未实际变化则不保存
      const finalStartPos = st.kind === 'start' ? st.sec : startSecBase;
      const finalEndPos = st.kind === 'end' ? st.sec : endPosBase;
      if (Math.abs(finalStartPos - startSecBase) < 0.25 && Math.abs(finalEndPos - endPosBase) < 0.25) return;
      // 松手补跳一次，让画面停在最终裁剪点
      seekPreview(st.sec, true);
      const finalEndSec = Math.max(0, durationSec - finalEndPos);
      await commitManual(finalStartPos, finalEndSec);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [durationSec, startSecBase, endPosBase, clampStart, clampEnd, commitManual, seekPreview]);
  const jumpStart = useCallback(() => onJumpVideoMs?.(state.trim.trimStartMs || 0), [onJumpVideoMs, state.trim.trimStartMs]);
  // 片尾跳转：跳到正剧结束点（ED 开始点）= 总时长 - 尾部裁剪量
  const jumpEnd = useCallback(() => {
    const ms = Math.max(0, (durationMs || 0) - (state.trim.trimEndMs || 0));
    onJumpVideoMs?.(ms);
  }, [onJumpVideoMs, durationMs, state.trim.trimEndMs]);

  /** 🎯 采纳 P1 候选时间点：以 USER_MANUAL 身份写入（候选点即"手动选择"入口，替代自动兜底） */
  const adoptCandidate = useCallback(async (kind: 'op' | 'ed', sec: number) => {
    if (!projectId || !mediaId || !isFinite(sec)) return;
    const base = state.trim;
    const totalSec = (durationMs && durationMs > 0 ? durationMs : 0) / 1000;
    const payload = kind === 'op'
      ? { trimStartMs: Math.round(sec * 1000), trimEndMs: base.trimEndMs || 0, confidence: 1, note: `用户采纳候选点：OP @ ${fmtMs(Math.round(sec * 1000))}` }
      : {
          // 候选点是 ED 开始点（从 0 计），需换算成尾部裁剪量
          trimStartMs: base.trimStartMs || 0,
          trimEndMs: totalSec > 0 ? Math.round(Math.max(0, totalSec - sec) * 1000) : Math.round(sec * 1000),
          confidence: 1,
          note: `用户采纳候选点：ED @ ${fmtMs(Math.round(sec * 1000))}${totalSec > 0 ? `（裁掉尾部 ${fmtMs(Math.round((totalSec - sec) * 1000))}）` : ''}`,
        };
    const r = await (window as any).api?.invoke?.(IPC_CHANNELS.OPED_ACCEPT_SUGGESTION, projectId, mediaId, payload, 'ui');
    if (r?.ok) {
      setPendingTrim(null); // 已写库，退出识别预览
      await reloadState();
      setOpCandidates([]);
      setEdCandidates([]);
    } else {
      alert('采纳候选点失败: ' + (r?.error || 'unknown'));
    }
  }, [projectId, mediaId, state.trim, durationMs, reloadState]);

  const sortedHistory = useMemo(() => [...state.history].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [state.history]);
  const hasAny = (state.trim.trimStartMs > 0) || (state.trim.trimEndMs > 0) || state.history.length > 0;

  if (!projectId || !mediaId) {
    return (
      <div className="rounded-lg border border-dashed border-border/40 bg-muted/20 p-3 text-[12px] text-muted-foreground">
        <div className="flex items-center gap-2"><AlertCircle size={14} />请先选择视频素材以配置 OP/ED 裁剪。</div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-3`}>
      {/* 1) 生效值 + 手动输入 + 保存按钮 */}
      <div className="rounded-lg border border-border/50 bg-muted/20 p-3 shadow-inner flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Scissors size={14} className="text-accent" />
            <span className="text-[13px] font-semibold text-foreground/90">片头片尾裁剪（OP / ED）</span>
            <Badge variant={hasAny ? 'success' : 'default'}>
              {hasAny ? '已配置' : '未配置'}
            </Badge>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={runDetect}
              disabled={runningDetect || loadingState || !mediaPath}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-primary/90 text-white text-[11px] font-medium hover:bg-primary transition-colors shadow-sm shadow-primary/20 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {runningDetect ? <Loader2 size={11} className="animate-spin" /> : <Wand2 size={11} />}
              {runningDetect ? '自动识别中…' : '🔍 自动识别 OP/ED'}
            </button>
          </div>
        </div>

        {/* 1b) 双柄滑块：整条=视频完整时长；左滑点向右滑=片头裁剪从0增；右滑点向左滑=片尾裁剪从0增；松手按保留段保存一次（无时长时回退输入框） */}
        {durationSec > 0 ? (
          <div className="flex flex-col gap-1.5">
            {/* 时间码：左=片头裁剪量 / 右=片尾裁剪量（向左滑从0增大） */}
            <div className="flex items-center justify-between text-[12px]">
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                <span className="text-muted-foreground/75">片头</span>
                <span className={`font-mono tabular-nums ${dragKind === 'start' ? 'text-emerald-600 font-bold' : 'text-foreground/90'}`}>
                  {fmtMs(Math.round(startPosPreview * 1000))}
                </span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className={`font-mono tabular-nums ${dragKind === 'end' ? 'text-amber-600 font-bold' : 'text-foreground/90'}`}>
                  {fmtMs(Math.round((durationSec - endPosPreview) * 1000))}
                </span>
                <span className="text-muted-foreground/75">片尾</span>
                <span className="w-2 h-2 rounded-full bg-amber-500" />
              </span>
            </div>
            {/* 轨道：整条=视频完整时长（0 → 总时长），左右各一滑点 */}
            <div
              ref={trackRef}
              onPointerDown={handleTrackDown}
              className="relative h-5 touch-none select-none cursor-pointer"
            >
              {/* 左删除区：0 → 片头滑点（将被裁掉） */}
              <div className="absolute top-1/2 -translate-y-1/2 h-1.5 rounded-l-full bg-foreground/15"
                   style={{ left: 0, width: `${pctOf(startPosPreview)}%` }} />
              {/* 保留区：片头滑点 → 片尾滑点（正剧内容） */}
              <div className="absolute top-1/2 -translate-y-1/2 h-1.5 bg-accent"
                   style={{ left: `${pctOf(startPosPreview)}%`, width: `${Math.max(0, pctOf(endPosPreview) - pctOf(startPosPreview))}%` }} />
              {/* 右删除区：片尾滑点 → 结尾（将被裁掉，左滑即扩大） */}
              <div className="absolute top-1/2 -translate-y-1/2 h-1.5 rounded-r-full bg-foreground/15"
                   style={{ left: `${pctOf(endPosPreview)}%`, width: `${100 - pctOf(endPosPreview)}%` }} />
              {/* 左滑点（绿·片头） */}
              <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full bg-emerald-500 ring-2 ring-background shadow-sm"
                   style={{ left: `${pctOf(startPosPreview)}%` }} />
              {/* 右滑点（黄·片尾） */}
              <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full bg-amber-500 ring-2 ring-background shadow-sm"
                   style={{ left: `${pctOf(endPosPreview)}%` }} />
            </div>
            <div className="flex items-center justify-between text-[11px] text-muted-foreground/70">
              <span>松手自动保存</span>
              <div className="flex items-center gap-1.5">
                <button type="button" onClick={jumpStart} disabled={!onJumpVideoMs || state.trim.trimStartMs <= 0}
                  className="shrink-0 px-2 py-0.5 rounded bg-muted/60 border border-border/30 text-[11px] cursor-pointer hover:bg-muted/80 disabled:opacity-40 disabled:cursor-not-allowed"><Play size={10} className="inline-block mr-0.5" />片头</button>
                <button type="button" onClick={jumpEnd} disabled={!onJumpVideoMs || (durationMs || 0) - (state.trim.trimEndMs || 0) <= 0}
                  className="shrink-0 px-2 py-0.5 rounded bg-muted/60 border border-border/30 text-[11px] cursor-pointer hover:bg-muted/80 disabled:opacity-40 disabled:cursor-not-allowed"><Play size={10} className="inline-block mr-0.5" />片尾</button>
              </div>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2.5">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground/80">片头裁剪（秒）</span>
              <div className="flex items-center gap-1.5">
                <input type="text" inputMode="text" value={trimStartSecInput} onChange={(e) => setTrimStartSecInput(e.target.value)}
                  className="flex-1 px-2 py-1 rounded bg-background border border-border/40 text-[13px] font-mono focus:border-accent focus:outline-none" placeholder="如 85" />
                <button type="button" onClick={jumpStart} disabled={!onJumpVideoMs || state.trim.trimStartMs <= 0}
                  className="shrink-0 px-2 py-1 rounded bg-muted/60 border border-border/30 text-[11px] cursor-pointer hover:bg-muted/80 disabled:opacity-40 disabled:cursor-not-allowed"><Play size={11} className="inline-block mr-0.5" />跳转</button>
              </div>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground/80">片尾裁剪（秒）</span>
              <div className="flex items-center gap-1.5">
                <input type="text" inputMode="text" value={trimEndSecInput} onChange={(e) => setTrimEndSecInput(e.target.value)}
                  className="flex-1 px-2 py-1 rounded bg-background border border-border/40 text-[13px] font-mono focus:border-accent focus:outline-none" placeholder="如 105" />
                <button type="button" onClick={saveManualTrim}
                  className="shrink-0 px-2 py-1 rounded bg-accent-green/90 text-white text-[11px] font-medium hover:bg-accent-green shadow-sm shadow-accent-green/20 transition-colors cursor-pointer"><Check size={11} className="inline-block mr-0.5" />保存</button>
              </div>
            </label>
          </div>
        )}

        {/* 自动识别状态：单行提示（收敛原终端式日志，识别/采纳动作反馈） */}
        {(detectStatus || lastDetectError) && (
          <div
            className={`rounded-md border px-2 py-1 flex items-center gap-1.5 text-[11px] ${
              detectStatus?.kind === 'running' ? 'border-border/30 bg-muted/30 text-muted-foreground'
              : detectStatus?.kind === 'ok' ? 'border-accent-green/30 bg-accent-green/5 text-foreground/80'
              : detectStatus?.kind === 'warn' ? 'border-accent-yellow/35 bg-accent-yellow/5 text-foreground/85'
              : 'border-accent-rose/30 bg-accent-rose/5 text-accent-rose'
            }`}
          >
            {detectStatus?.kind === 'running'
              ? <Loader2 size={12} className="animate-spin shrink-0" />
              : detectStatus?.kind === 'ok'
                ? <Check size={12} className="text-accent-green shrink-0" />
                : detectStatus?.kind === 'warn'
                  ? <Sparkles size={12} className="text-accent-yellow shrink-0" />
                  : <AlertCircle size={12} className="shrink-0" />}
            <span className="whitespace-pre-wrap break-all">{detectStatus ? detectStatus.text : lastDetectError}</span>
          </div>
        )}

        {/* 候选时间点：P1 Top3 作为轨道锚点（点击即采纳），紧贴滑块下方，与手动选择共用同一轨道语义 */}
        {(opCandidates.length > 0 || edCandidates.length > 0) && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <span className="inline-flex items-center gap-1 font-semibold text-muted-foreground/80">
              <Sparkles size={11} className="text-accent" />候选点
            </span>
            {opCandidates.map((c, i) => (
              <button
                key={`op-${i}`}
                type="button"
                onClick={() => adoptCandidate('op', c.sec)}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-accent-green/30 bg-accent-green/5 text-accent-green font-mono hover:bg-accent-green/15 transition-colors cursor-pointer"
                title="采纳该点为片头裁剪（OP 结束点）"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
                OP {fmtMs(Math.round(c.sec * 1000))} · {fmtConf(c.score)}
              </button>
            ))}
            {edCandidates.map((c, i) => (
              <button
                key={`ed-${i}`}
                type="button"
                onClick={() => adoptCandidate('ed', c.sec)}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-accent-yellow/30 bg-accent-yellow/5 text-accent-yellow font-mono hover:bg-accent-yellow/15 transition-colors cursor-pointer"
                title="采纳该点为片尾裁剪（ED 开始点）"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" />
                ED {fmtMs(Math.round(c.sec * 1000))} · {fmtConf(c.score)}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 2) 建议历史 */}
      {state.history.length > 0 && (
        <div className="rounded-lg border border-border/40 bg-background/60 p-2.5 shadow-sm flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => setExpandedHistory((v) => !v)}
            className="flex items-center justify-between text-left outline-none cursor-pointer hover:opacity-90"
          >
            <span className="flex items-center gap-1.5 text-[12px] font-semibold text-foreground/85">
              <History size={13} />建议历史（{state.history.length} 条）
            </span>
            <span className="text-[11px] text-muted-foreground/70">
              {expandedHistory ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </span>
          </button>
          {expandedHistory && (
            <div className="flex flex-col gap-1 mt-0.5">
              {sortedHistory.map((rec, displayIdx) => {
                const realIdx = state.history.indexOf(rec);
                const meta = SOURCE_META[rec.source] || { label: rec.source, short: rec.source, Icon: User, cls: '' };
                const I = meta.Icon;
                return (
                  <div
                    key={rec.createdAt + '-' + displayIdx}
                    className={`rounded-md border p-2 flex items-center gap-2 transition-colors ${rec.adopted ? 'border-accent-green/40 bg-accent-green/5' : 'border-border/30 bg-muted/10'}`}
                  >
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-medium border shrink-0 ${meta.cls}`}>
                      <I size={10.5} />{meta.short}
                    </span>
                    <span className="text-[11px] font-mono text-foreground/85 shrink-0" title={`置信 ${fmtConf(rec.confidence)}`}>
                      {/* ✅ 建议历史也统一用 mm:ss 展示（如 OP=1:25，和播放器时间码一致） */}
                      OP={fmtMs(rec.trimStartMs)} · ED={fmtMs(rec.trimEndMs)}
                    </span>
                    <Badge variant={rec.confidence >= 0.9 ? 'success' : rec.confidence >= 0.7 ? 'default' : 'warning'}>
                      置信 {fmtConf(rec.confidence)}
                    </Badge>
                    {rec.adopted && <Badge variant="success"><Check size={10} className="mr-0.5" />当前生效</Badge>}
                    <span className="flex-1 text-[11px] text-muted-foreground/80 min-w-0 truncate" title={rec.note || ''}>
                      {rec.note || (rec.anchorMediaId ? `锚点素材 ${rec.anchorMediaId.slice(-10)}` : '')}
                    </span>
                    <span className="text-[10.5px] font-mono text-muted-foreground/60 shrink-0">
                      {new Date(rec.createdAt).toLocaleTimeString()}
                    </span>
                    {!rec.adopted && (
                      <button
                        type="button"
                        onClick={() => acceptHistory(realIdx)}
                        className="shrink-0 px-1.5 py-0.5 rounded bg-primary/90 hover:bg-primary text-white text-[10.5px] font-medium transition-colors cursor-pointer"
                        title="接受该建议（以用户身份写入，自动识别不再覆盖）"
                      >
                        ✅ 接受建议
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 3) 首次使用提示条（未配置时展示） */}
      {!hasAny && !detectStatus && !runningDetect && (
        <div className="rounded-md border border-accent/30 bg-accent/5 p-2 flex items-start gap-1.5 text-[11px] text-foreground/85">
          <Sparkles size={13} className="text-accent shrink-0 mt-[2px]" />
          <div className="flex-1 min-w-0">
            <div className="font-semibold">首次使用：直接点【🔍 自动识别 OP/ED】</div>
            <div className="text-muted-foreground/80 mt-0.5 leading-relaxed">
              命中率高直接落到滑杆生效；不确定时预置最佳候选，可直接拖动微调，或点下方候选点采纳。
            </div>
          </div>
          <button type="button" onClick={() => setExpandedHistory(true)} className="shrink-0 text-muted-foreground/60 hover:text-foreground"><X size={12} /></button>
        </div>
      )}
    </div>
  );
};
