// Module: pipeline/step4-tts - Container
// @migrated 阶段三：从 useStore → useStep4Store + useStep3Store + usePipelineStore + useProjectStore
// 阶段四：移除 mapPipelineResultToState 的 useStore fallback

import React, { useState, useCallback, useRef } from "react";
import { useStep4Store } from "../../stores/useStep4Store";
import { useStep3Store } from "../../stores/useStep3Store";
import { usePipelineStore } from "@renderer/store/usePipelineStore";
import { useProjectStore } from "@modules/editor/stores/useProjectStore";
import { API } from "@renderer/api";
import { mapPipelineResultToState } from "@modules/editor/shell/frontend/hooks/usePipelineResultMapper";
import { buildMappers } from "@modules/editor/shell/frontend/hooks/usePipelineOrchestrator";
import { STEP_SEQUENCES } from "@modules/editor/shell/utils/pipelineConstants";
import { persistProjectSnapshot } from "@modules/editor/shell/utils/persistSnapshot";
import { AppNotifier } from "@renderer/core/AppNotifier";
import { getSafeMediaUrl } from "@renderer/utils/formatUrl";
import { StepTTSSynthesisView } from "./View";
import type { TtsVoiceOption } from "../types";
import type { OriginalAudioParagraph } from "../../../../shared/types/entities/editor";

const VOICE_OPTIONS: Record<string, TtsVoiceOption[]> = {
  edge: [
    { id: "zh-CN-XiaoxiaoNeural", name: "晓晓", lang: "中文·女" },
    { id: "zh-CN-YunxiNeural", name: "云希", lang: "中文·男" },
    { id: "zh-CN-YunyangNeural", name: "云扬", lang: "中文·男" },
    { id: "zh-CN-XiaoyiNeural", name: "晓伊", lang: "中文·女" },
    { id: "zh-CN-YunjianNeural", name: "云健", lang: "中文·男" },
  ],
  doubao: [
    { id: "zh_female_meilinvyou_saturn_bigtts", name: "美女邻居", lang: "中文·女" },
    { id: "zh_male_shaunglangxueke_moon_bigtts", name: "爽朗学客", lang: "中文·男" },
  ],
  // Kokoro-82M 本地推理引擎（官方 v1.0-zh 仅 8 个音色，与 HF voices/*.pt 一一对应）
  // 注意：勿添加不存在的音色 id（如 zf_xiaomo/zm_yunye），HF 无此文件会导致试听合成 404
  kokoro: [
    { id: "zf_xiaobei", name: "小北", lang: "中文·女" },
    { id: "zf_xiaoni", name: "小妮", lang: "中文·女" },
    { id: "zf_xiaoxiao", name: "小小", lang: "中文·女" },
    { id: "zf_xiaoyi", name: "小一", lang: "中文·女" },
    { id: "zm_yunjian", name: "云健", lang: "中文·男" },
    { id: "zm_yunxi", name: "云希", lang: "中文·男" },
    { id: "zm_yunxia", name: "云霞", lang: "中文·男" },
    { id: "zm_yunyang", name: "云扬", lang: "中文·男" },
  ],
};

export const StepTTSSynthesis: React.FC = () => {
  const ttsEngine = useStep4Store((s) => s.ttsEngine);
  const ttsVoiceId = useStep4Store((s) => s.ttsVoiceId);
  const ttsProgress = useStep4Store((s) => s.ttsProgress);
  const ttsResults = useStep4Store((s) => s.ttsResults);
  const setTtsEngine = useStep4Store((s) => s.setTtsEngine);
  const setTtsVoiceId = useStep4Store((s) => s.setTtsVoiceId);

  const scriptParagraphs = useStep3Store((s) => s.scriptParagraphs);

  const [speechRate, setSpeechRate] = useState(1.0);
  const [playingIdx, setPlayingIdx] = useState<number | null>(null);
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);
  // 顺序播放状态：isSequentialPlaying 是否正在顺序播放；sequentialIdx 当前播放段索引；isPaused 是否暂停中
  const [isSequentialPlaying, setIsSequentialPlaying] = useState(false);
  const [sequentialIdx, setSequentialIdx] = useState<number | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  // 单段配音：当前正在合成的段落索引（null 表示无单段合成进行中）
  const [singleSynthIdx, setSingleSynthIdx] = useState<number | null>(null);

  const PREVIEW_TEXT_MAP: Record<string, string> = {
    zh: '欢迎使用 Zentect 智能剪辑，这是一段语音合成测试。',
    en: 'Welcome to Zentect, this is a voice synthesis preview.',
    ja: 'Zentectへようこそ、これは音声合成のテストです。',
  };

  const getPreviewText = (voiceId: string, lang?: string): string => {
    // 优先用后端返回的 lang 字段判断语言
    const langLower = (lang || '').toLowerCase();
    if (langLower.startsWith('english') || langLower.startsWith('en')) return PREVIEW_TEXT_MAP.en;
    if (langLower.startsWith('japanese') || langLower.startsWith('ja')) return PREVIEW_TEXT_MAP.ja;
    // 回退：用 voiceId 前缀判断 edge/doubao 引擎的音色
    if (voiceId.startsWith('en-')) return PREVIEW_TEXT_MAP.en;
    if (voiceId.startsWith('ja-')) return PREVIEW_TEXT_MAP.ja;
    return PREVIEW_TEXT_MAP.zh;
  };
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // 播放令牌：每次启动播放递增，async 试听返回后校验，防止竞态覆盖
  // 解决「先点试听、再点列表播放、试听返回后覆盖列表播放」的竞态
  const playTokenRef = useRef(0);
  // 顺序播放队列快照：启动顺序播放时一次性捕获有效段落索引列表，避免播放期间 ttsResults 变动影响队列
  const sequentialQueueRef = useRef<number[]>([]);
  // 顺序播放队列游标：当前播放到队列的第几项（与 sequentialIdx 不同，queue 存的是有效段落索引）
  const sequentialCursorRef = useRef(0);

  // 停止当前音频并对称清空所有播放状态（单段播放、试听、顺序播放）
  const stopAudio = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.currentTime = 0; }
    setPlayingIdx(null);
    setPreviewingVoiceId(null);
    setIsSequentialPlaying(false);
    setSequentialIdx(null);
    setIsPaused(false);
  }, []);

    // 配音列表播放：直接使用已合成的 audioUrl
    // 注意：不得设置 audio.playbackRate —— speechRate 已由后端合成时应用（Edge/豆包等引擎
    // 的 speed/speed_ratio 参数），前端再变速会语速双重应用 + 音调变调，导致"听不清"
    const handlePreview = useCallback((idx: number, audioUrl: string) => {
    console.log('[handlePreview] 点击配音列表播放按钮', { idx, audioUrl, ttsResults: useStep4Store.getState().ttsResults });
    if (!audioUrl) return;
    if (playingIdx === idx) { stopAudio(); return; }
    stopAudio();
    // 递增 token，使进行中的 async 试听失效
    const token = ++playTokenRef.current;
    const audio = new Audio(audioUrl); audioRef.current = audio;
    // 🐛 双提示去重：同一音频加载失败会同时触发 play().catch 与 error 事件，
    //   用标志保证只弹一次提示（此前原声段试听失败会重复弹框）
    let errorNotified = false;
    const notifyOnce = (msg: string) => {
      if (errorNotified || playTokenRef.current !== token) return;
      errorNotified = true;
      setPlayingIdx(null);
      AppNotifier.warning(msg);
    };
    audio.play().catch(() => {
      // 播放失败：文件可能已失效（旧项目脏数据、L2 cache 被清理等），提示用户重新合成
      notifyOnce("音频文件已失效，请重新合成");
    }); setPlayingIdx(idx);
    audio.onended = () => { if (playTokenRef.current === token) setPlayingIdx(null); };
    audio.onerror = () => {
      // 加载失败（HTTP 错误/范围非法）：补充一次性提示，不再重复弹框
      notifyOnce("音频文件加载失败，请重新合成");
    };
  }, [playingIdx, speechRate, stopAudio]);

  /**
   * 原声段试听：基于原片时间轴截取 [sourceStartMs, sourceEndMs] 的音频片段播放。
   *
   * 原声段永远无 TTS 结果（后端已过滤），其"试听"必须是原片对应时间窗的真实台词。
   * 实现：给源视频 magic:// URL 追加 ?start/end（ms）查询参数，后端 magic 协议用 ffmpeg
   * 精确提取该时间窗纯音频返回；与解说段 TTS 试听互不影响。
   * 错就错：音频源信息缺失/时间窗非法时明确提示，不静默降级播放整片。
   */
  const handleOriginalAudioPreview = useCallback((idx: number, audioSource: OriginalAudioParagraph['audioSource']) => {
    console.log('[handleOriginalAudioPreview] 点击原声段试听', { idx, audioSource });
    const projectState = useProjectStore.getState();
    const mediaPath = projectState.mediaItems?.[0]?.filePath;
    const startMs = audioSource?.sourceStartMs;
    const endMs = audioSource?.sourceEndMs;
    if (!mediaPath || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      AppNotifier.warning("原声段音频时间窗不完整，无法试听");
      return;
    }
    const url = `${getSafeMediaUrl(mediaPath)}?start=${Math.round(startMs)}&end=${Math.round(endMs)}`;
    handlePreview(idx, url);
  }, [handlePreview]);

  // 音色试听：调用后端动态合成临时音频后播放（async，存在竞态，用 token 防护）
  const handleVoicePreview = useCallback(async (voiceId: string) => {
    console.log('[handleVoicePreview] 点击音色试听按钮', { voiceId, previewingVoiceId });
    // 点击正在试听的音色：停止
    if (previewingVoiceId === voiceId) { stopAudio(); return; }
    // 停止当前所有播放（列表播放或其他试听）
    stopAudio();
    setPreviewingVoiceId(voiceId);
    // 递增 token，使进行中的其他播放或试听失效
    const token = ++playTokenRef.current;
    try {
      const step4State = useStep4Store.getState();
      // 从当前音色列表中查找 lang 字段，用于判断预览文本语言
      const voiceList = VOICE_OPTIONS[step4State.ttsEngine] || [];
      const voice = voiceList.find((v) => v.id === voiceId);
      const previewText = getPreviewText(voiceId, voice?.lang);
      // 传 speechRate 让后端按当前语速合成试听音频
      const result = await API.voice.preview(step4State.ttsEngine, voiceId, previewText, speechRate);
      // token 校验：等待期间若有新播放启动（列表播放或切换试听），放弃此次试听结果
      if (playTokenRef.current !== token) return;
      if (result?.audioPath) {
        let url = result.audioPath;
        if (!url.startsWith("http") && !url.startsWith("magic://")) url = "magic://local/" + url.replace(/\\/g, "/");
        const audio = new Audio(url); audioRef.current = audio;
        // 注意：不得设置 playbackRate —— 后端已按 speechRate 合成试听音频，前端变速会双重应用+变调
        audio.play().catch(() => {});
        audio.onended = () => { if (playTokenRef.current === token) { setPlayingIdx(null); setPreviewingVoiceId(null); } };
        audio.onerror = () => { if (playTokenRef.current === token) setPreviewingVoiceId(null); };
      } else {
        // 无音频返回，清空试听状态
        setPreviewingVoiceId(null);
      }
    } catch {
      AppNotifier.error("试听失败");
      if (playTokenRef.current === token) setPreviewingVoiceId(null);
    }
  }, [previewingVoiceId, speechRate, stopAudio]);

  // 顺序播放：按段落顺序播放所有已合成成功的段落，支持暂停/继续，失败段自动跳过
  // 同一时间只能有一个播放上下文（单段/试听/顺序），启动顺序播放会停止其他播放
  const handleSequentialPlay = useCallback(() => {
    const results = useStep4Store.getState().ttsResults;
    const paragraphs = useStep3Store.getState().scriptParagraphs;

    // 暂停中再次点击：从当前位置继续播放
    if (isSequentialPlaying && isPaused) {
      if (audioRef.current) {
        audioRef.current.play().catch(() => {});
        setIsPaused(false);
      }
      return;
    }

    // 正在顺序播放中再次点击：暂停
    if (isSequentialPlaying && !isPaused) {
      if (audioRef.current) { audioRef.current.pause(); }
      setIsPaused(true);
      return;
    }

    // 启动新的顺序播放：构建有效段落索引队列（仅成功段，跳过失败/待合成）
    // ✅ 身份键统一：段落主键 p.id 与产物 id 同源，严格按 id 匹配，禁止下标回退，删除了旧 shotId 双门
    const queue: number[] = [];
    paragraphs.forEach((p: any, idx: number) => {
      const r = results.find((rr: any) => rr.id === p.id);
      if (r && !r._failed && r.audioUrl) queue.push(idx);
    });
    if (queue.length === 0) {
      AppNotifier.warning("暂无已合成的段落可播放");
      return;
    }

    // 停止当前所有播放，启动顺序播放
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.currentTime = 0; }
    setPlayingIdx(null);
    setPreviewingVoiceId(null);

    sequentialQueueRef.current = queue;
    sequentialCursorRef.current = 0;
    setIsSequentialPlaying(true);
    setIsPaused(false);

    const token = ++playTokenRef.current;

    // 播放队列中指定游标的段落，播放完自动前进到下一段
    const playAtCursor = () => {
      if (playTokenRef.current !== token) return;
      const cursor = sequentialCursorRef.current;
      const queueArr = sequentialQueueRef.current;
      if (cursor >= queueArr.length) {
        // 队列播放完毕，清空状态
        setIsSequentialPlaying(false);
        setSequentialIdx(null);
        setIsPaused(false);
        return;
      }
      const paragraphIdx = queueArr[cursor];
      const p = paragraphs[paragraphIdx];
      const r = results.find((rr: any) => rr.id === p?.id);
      if (!r || !r.audioUrl) {
        // 防御：队列构建时已过滤，理论上不会进入；若进入则跳过下一段
        sequentialCursorRef.current = cursor + 1;
        playAtCursor();
        return;
      }
      const audio = new Audio(r.audioUrl);
      // 注意：不得设置 playbackRate —— speechRate 已由后端合成时应用，前端变速会双重应用+变调
      audioRef.current = audio;
      setSequentialIdx(paragraphIdx);
      audio.play().catch(() => {
        // 播放失败：跳过本段，前进到下一段
        sequentialCursorRef.current = cursor + 1;
        playAtCursor();
      });
      audio.onended = () => {
        if (playTokenRef.current !== token) return;
        sequentialCursorRef.current = cursor + 1;
        playAtCursor();
      };
      audio.onerror = () => {
        if (playTokenRef.current !== token) return;
        sequentialCursorRef.current = cursor + 1;
        playAtCursor();
      };
    };

    playAtCursor();
  }, [isSequentialPlaying, isPaused, speechRate]);

  // 停止顺序播放（独立停止按钮，区别于暂停）
  const handleSequentialStop = useCallback(() => {
    stopAudio();
  }, [stopAudio]);

  const handleSynthesize = useCallback(async () => {
    const step3State = useStep3Store.getState();
    const step4State = useStep4Store.getState();
    const projectState = useProjectStore.getState();
    const pipelineState = usePipelineStore.getState();

    if (!step3State.scriptParagraphs?.length) { AppNotifier.warning("请先完成步骤3（解说文案）"); return; }
    console.log('[步骤4诊断] scriptParagraphs 数量=', step3State.scriptParagraphs.length, '首个=', JSON.stringify(step3State.scriptParagraphs[0]));
    setIsSynthesizing(true);
    // 合成前主动清空历史 TTS 结果与进度，避免残留旧数据（含试听/上次失败产物）被误匹配播放
    // 严格遵循"错就错"原则：新合成开始即丢弃旧状态，错误以原始形态暴露，不靠 if 守卫兜底
    useStep4Store.getState().setTtsResults([]);
    useStep4Store.getState().setTtsProgress(0);
    // 🔧 修复：resetPipeline 必须在 setPipelineRunning(true) 之前调用
    pipelineState.resetPipeline();
    pipelineState.setStepStatus(4, "running");
    pipelineState.setPipelineRunning(true);
    try {
      const sequence = STEP_SEQUENCES[4].map((node: any) => ({
        ...node,
        params: {
          ...(node.params || {}),
          ttsEngine: step4State.ttsEngine || "edge",
          voiceId: step4State.ttsVoiceId || "",
          speechRate: speechRate,  // 语速倍率(0.5~2.0)，传给后端 TTS 引擎
          mediaPath: projectState.mediaItems?.[0]?.filePath || "",
          scriptShots: step3State.scriptParagraphs || [],
        }
      }));
      const result = await API.engine.runPipeline({
        projectId: projectState.projectId,
        sequence,
        sourceMedia: projectState.mediaItems?.[0]?.filePath || "",
      });
      if (result) mapPipelineResultToState(result?.data || result, buildMappers());
      pipelineState.setStepCompleted(4, true);
      pipelineState.setStepStatus(4, "completed");
      // 💥 根因修复：步骤4独立流程完成时统一落盘，否则 SQLite 步骤状态不更新，
      //   重开项目步骤4回退为 idle，导致无法进入步骤5
      if (projectState.projectId) {
        try {
          await persistProjectSnapshot(projectState.projectId);
        } catch (saveErr) {
          console.error("[步骤4] 配音合成落盘失败:", saveErr);
        }
      }
    } catch (err: any) {
      pipelineState.setStepStatus(4, "failed");
      pipelineState.setPipelineError(err?.message || "配音合成失败");
    }
    finally {
      pipelineState.setPipelineRunning(false);
      setIsSynthesizing(false);
    }
  }, []);

  // 单段配音：仅合成指定段落，立即更新 ttsResults 对应条目（不依赖全局 pipeline）
  // 语速 speechRate 只在合成时传给后端（Edge/豆包生效），播放端不变速
  const handleSingleSynthesize = useCallback(async (idx: number) => {
    const step3State = useStep3Store.getState();
    const step4State = useStep4Store.getState();
    const projectState = useProjectStore.getState();
    const p = step3State.scriptParagraphs?.[idx];
    // 判别联合三段式拦截：段落不存在 / 原声保留段（无解说词不应合成）/ 解说段空文案；
    // 三重守卫之后 p 收窄为 NarrationParagraph，下游 p.text 为必填 string 可安全读取
    if (!p) { AppNotifier.warning(`第 ${idx + 1} 段不存在`); return; }
    if (p.type === 'original_audio') { AppNotifier.info(`第 ${idx + 1} 段为原声保留段，无需配音`); return; }
    if (!p.text) { AppNotifier.warning(`第 ${idx + 1} 段没有文案`); return; }
    // 🛑 错就错：单段配音必须要有项目 ID，缺失时明确报错，不做兜底
    if (!projectState.projectId) { AppNotifier.warning('系统异常：未找到当前工程 ID'); return; }
    if (singleSynthIdx !== null) return; // 已有单段合成进行中
    setSingleSynthIdx(idx);
    stopAudio();
    // ✅ 身份键统一：段落主键 id 出生处即全局唯一，单段试听产物亦以 id 记
    const shotId = p.id;
    try {
      const result = await API.ai.runSingleTTS(projectState.projectId, {
        id: shotId,
        text: p.text,
        voiceId: step4State.ttsVoiceId || undefined,
        speechRate,
        provider: step4State.ttsEngine || 'edge',
      });
      const audioPath = result?.audioPath || '';
      // 本地绝对路径 → magic://local/ URL 供 Audio 标签播放
      let audioUrl = audioPath;
      if (audioUrl && !audioUrl.startsWith('http') && !audioUrl.startsWith('magic://')) {
        audioUrl = `magic://local/${audioUrl.replace(/\\/g, '/')}`;
      }
      const entry = {
        id: shotId,
        shotId,
        audioUrl,
        duration: p.duration || 0,
        _failed: !audioPath,
        _error: !audioPath ? (result?.error || '合成失败') : '',
      };
      const cur = useStep4Store.getState().ttsResults || [];
      const idxIn = cur.findIndex((r: any) => r.id === shotId);
      const next = idxIn >= 0 ? cur.map((r: any, i: number) => (i === idxIn ? entry : r)) : [...cur, entry];
      useStep4Store.getState().setTtsResults(next);
      if (!audioPath) AppNotifier.error(`第 ${idx + 1} 段合成失败: ${result?.error || ''}`);
    } catch (err: any) {
      // 错就错：失败必须标记进结果列表，不让用户误以为成功
      const cur = useStep4Store.getState().ttsResults || [];
      const entry = { id: shotId, shotId, audioUrl: '', duration: p.duration || 0, _failed: true, _error: err?.message || '合成失败' };
      const idxIn = cur.findIndex((r: any) => r.id === shotId);
      const next = idxIn >= 0 ? cur.map((r: any, i: number) => (i === idxIn ? entry : r)) : [...cur, entry];
      useStep4Store.getState().setTtsResults(next);
      AppNotifier.error(`第 ${idx + 1} 段合成失败: ${err?.message || ''}`);
    } finally {
      setSingleSynthIdx(null);
    }
  }, [speechRate, stopAudio, singleSynthIdx]);

  // isProcessing 只依赖步骤4自身的合成状态，不耦合全局 pipelineRunning
  // 避免其他步骤(如 step3 等 LLM 响应)running 时卡死步骤4的引擎/音色选择
  const isProcessing = isSynthesizing;
  const successCount = ttsResults.filter((r: any) => r.audioUrl && !r._failed).length;
  const failedCount = ttsResults.filter((r: any) => r._failed || !r.audioUrl).length;

  return (
    <StepTTSSynthesisView
      ttsEngine={ttsEngine} ttsVoiceId={ttsVoiceId} ttsProgress={ttsProgress} ttsResults={ttsResults}
      scriptParagraphs={scriptParagraphs} isProcessing={isProcessing}
      voices={VOICE_OPTIONS[ttsEngine] || []}
      speechRate={speechRate} previewingVoiceId={previewingVoiceId} playingIdx={playingIdx}
      successCount={successCount} failedCount={failedCount}
      singleSynthIdx={singleSynthIdx}
      isSequentialPlaying={isSequentialPlaying} sequentialIdx={sequentialIdx} isPaused={isPaused}
      onSetTtsEngine={setTtsEngine} onSetTtsVoiceId={setTtsVoiceId} onSetSpeechRate={setSpeechRate}
      onPreview={handlePreview} onVoicePreview={handleVoicePreview} onSynthesize={handleSynthesize}
      onSingleSynthesize={handleSingleSynthesize}
      onOriginalAudioPreview={handleOriginalAudioPreview}
      onSequentialPlay={handleSequentialPlay} onSequentialStop={handleSequentialStop}
    />
  );
};
