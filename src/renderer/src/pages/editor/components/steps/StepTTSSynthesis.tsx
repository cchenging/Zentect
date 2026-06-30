import React, { useState, useCallback, useRef, useEffect } from "react";
import { useStore } from "../../../../store/useStore";
import { API } from "../../../../api";
import { mapPipelineResultToState } from "../../hooks/usePipelineResultMapper";
import { STEP_SEQUENCES } from "../../utils/pipelineConstants";
import { AppNotifier } from "../../../../core/AppNotifier";
import { StepTTSSynthesisView, type TtsVoiceOption } from "./containers/StepTTSSynthesisView";

const VOICE_OPTIONS: Record<string, TtsVoiceOption[]> = {
  edge: [
    { id: "zh-CN-XiaoxiaoNeural", name: "晓晓", lang: "中文·女" },
    { id: "zh-CN-YunxiNeural", name: "云希", lang: "中文·男" },
    { id: "zh-CN-YunyangNeural", name: "云扬", lang: "中文·男" },
    { id: "zh-CN-XiaoyiNeural", name: "晓伊", lang: "中文·女" },
    { id: "zh-CN-YunjianNeural", name: "云健", lang: "中文·男" },
  ],
  moss: [
    { id: 'Junhao', name: '俊豪', lang: '中文·男' },
    { id: 'Zhiming', name: '志明', lang: '中文·男' },
    { id: 'Weiguo', name: '卫国', lang: '中文·男' },
    { id: 'Xiaoyu', name: '小雨', lang: '中文·女' },
    { id: 'Yuewen', name: '悦文', lang: '中文·女' },
    { id: 'Lingyu', name: '灵语', lang: '中文·女' },
    { id: 'Ava', name: 'Ava', lang: '英文·女' },
    { id: 'Bella', name: 'Bella', lang: '英文·女' },
    { id: 'Adam', name: 'Adam', lang: '英文·男' },
    { id: 'Nathan', name: 'Nathan', lang: '英文·男' },
    { id: 'Trump', name: 'Trump', lang: '英文·男' },
    { id: 'Sakura', name: 'Sakura', lang: '日文·女' },
    { id: 'Yui', name: 'Yui', lang: '日文·女' },
    { id: 'Aoi', name: 'Aoi', lang: '日文·女' },
    { id: 'Hina', name: 'Hina', lang: '日文·女' },
    { id: 'Mei', name: 'Mei', lang: '日文·女' },
  ],
  doubao: [
    { id: "zh_female_meilinvyou_saturn_bigtts", name: "美女邻居", lang: "中文·女" },
    { id: "zh_male_shaunglangxueke_moon_bigtts", name: "爽朗学客", lang: "中文·男" },
  ],
  fish: [{ id: "default", name: "默认音色", lang: "通用" }],
  sovits: [{ id: "default", name: "克隆音色", lang: "通用" }],
};

export const StepTTSSynthesis: React.FC = () => {
  const ttsEngine = useStore((s) => s.ttsEngine);
  const ttsVoiceId = useStore((s) => s.ttsVoiceId);
  const ttsProgress = useStore((s) => s.ttsProgress);
  const ttsResults = useStore((s) => s.ttsResults);
  const scriptParagraphs = useStore((s) => s.scriptParagraphs);
  const pipelineRunning = useStore((s) => s.pipelineRunning);
  const setTtsEngine = useStore((s) => s.setTtsEngine);
  const setTtsVoiceId = useStore((s) => s.setTtsVoiceId);

  const [speechRate, setSpeechRate] = useState(1.0);
  const [playingIdx, setPlayingIdx] = useState<number | null>(null);
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [clonedVoices, setClonedVoices] = useState<TtsVoiceOption[]>([]);
  const [mossVoices, setMossVoices] = useState<TtsVoiceOption[]>([]);
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);

  const PREVIEW_TEXT_MAP: Record<string, string> = {
    zh: '欢迎使用 Zentect 智能剪辑，这是一段语音合成测试。',
    en: 'Welcome to Zentect, this is a voice synthesis preview.',
    ja: 'Zentectへようこそ、これは音声合成のテストです。',
  };

  const getPreviewText = (voiceId: string): string => {
    if (['Ava', 'Bella', 'Adam', 'Nathan', 'Trump'].includes(voiceId)) return PREVIEW_TEXT_MAP.en;
    if (['Sakura', 'Yui', 'Aoi', 'Hina', 'Mei'].includes(voiceId)) return PREVIEW_TEXT_MAP.ja;
    if (voiceId.startsWith('en-')) return PREVIEW_TEXT_MAP.en;
    if (voiceId.startsWith('ja-')) return PREVIEW_TEXT_MAP.ja;
    return PREVIEW_TEXT_MAP.zh;
  };
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (ttsEngine === "sovits" || ttsEngine === "fish") {
      setMossVoices([]);
      API.voice.getClonedVoices().then((res: any) => {
        if (res?.voices && Array.isArray(res.voices)) setClonedVoices(res.voices.map((v: any) => ({ id: v.id, name: v.name, lang: "克隆" })));
      }).catch(() => {});
    } else if (ttsEngine === "moss") {
      setClonedVoices([]);
      API.voice.listByEngine("moss").then((voices: any) => {
        if (Array.isArray(voices) && voices.length > 0) setMossVoices(voices);
      }).catch(() => { setMossVoices([]); });
    } else { setClonedVoices([]); setMossVoices([]); }
  }, [ttsEngine]);

  const stopAudio = useCallback(() => { if (audioRef.current) { audioRef.current.pause(); audioRef.current.currentTime = 0; } setPlayingIdx(null); }, []);

  const handlePreview = useCallback((idx: number, audioUrl: string) => {
    if (!audioUrl) return;
    if (playingIdx === idx) { stopAudio(); return; }
    stopAudio();
    const audio = new Audio(audioUrl); audio.playbackRate = speechRate; audioRef.current = audio;
    audio.play().catch(() => {}); setPlayingIdx(idx);
    audio.onended = () => setPlayingIdx(null); audio.onerror = () => setPlayingIdx(null);
  }, [playingIdx, speechRate, stopAudio]);

  const handleVoicePreview = useCallback(async (voiceId: string) => {
    if (previewingVoiceId === voiceId) { stopAudio(); setPreviewingVoiceId(null); return; } if (previewingVoiceId) { stopAudio(); setPreviewingVoiceId(null); }
    setPreviewingVoiceId(voiceId);
    try {
      const state = useStore.getState();
      const previewText = getPreviewText(voiceId)
        || "欢迎使用 Zentect 智能剪辑，这是一段语音合成测试。";
      const result = await API.voice.preview(ttsEngine, voiceId, previewText);
      if (result?.audioPath) {
        stopAudio();
        let url = result.audioPath;
        if (!url.startsWith("http") && !url.startsWith("magic://")) url = "magic://local/" + url.replace(/\\/g, "/");
        const audio = new Audio(url); audioRef.current = audio;
        audio.play().catch(() => {}); audio.onended = () => { setPlayingIdx(null); setPreviewingVoiceId(null); };
        audio.onerror = () => setPreviewingVoiceId(null);
      }
    } catch { AppNotifier.error("试听失败"); }
    setPreviewingVoiceId(null);
  }, [ttsEngine, previewingVoiceId, stopAudio]);

  const handleSynthesize = useCallback(async () => {
    const state = useStore.getState();
    if (!state.scriptParagraphs?.length) { AppNotifier.warning("请先完成步骤3（解说文案）"); return; }
    setIsSynthesizing(true); state.setStepStatus(4, "running"); state.setPipelineRunning(true); state.resetPipeline();
    try {
      const sequence = STEP_SEQUENCES[4].map((node: any) => ({ ...node, params: { ...(node.params || {}), ttsEngine: state.ttsEngine || "edge", voiceId: state.ttsVoiceId || "", mediaPath: state.mediaItems?.[0]?.filePath || "", scriptShots: state.scriptParagraphs || [] } }));
      const result = await API.engine.runPipeline({ projectId: state.projectId, sequence, sourceMedia: state.mediaItems?.[0]?.filePath || "" });
      if (result) mapPipelineResultToState(result?.data || result, useStore.getState());
      state.setStepCompleted(4, true); state.setStepStatus(4, "completed");
    } catch (err: any) { state.setStepStatus(4, "failed"); state.setPipelineError(err?.message || "配音合成失败"); }
    finally { state.setPipelineRunning(false); setIsSynthesizing(false); }
  }, []);

  const isProcessing = isSynthesizing || pipelineRunning;
  const successCount = ttsResults.filter((r: any) => r.audioUrl && !r._failed).length;
  const failedCount = ttsResults.filter((r: any) => r._failed || !r.audioUrl).length;

  return (
    <StepTTSSynthesisView
      ttsEngine={ttsEngine} ttsVoiceId={ttsVoiceId} ttsProgress={ttsProgress} ttsResults={ttsResults}
      scriptParagraphs={scriptParagraphs} isProcessing={isProcessing}
      voices={ttsEngine === 'moss' && mossVoices.length > 0 ? mossVoices : VOICE_OPTIONS[ttsEngine] || []} clonedVoices={clonedVoices}
      speechRate={speechRate} previewingVoiceId={previewingVoiceId} playingIdx={playingIdx}
      successCount={successCount} failedCount={failedCount}
      onSetTtsEngine={setTtsEngine} onSetTtsVoiceId={setTtsVoiceId} onSetSpeechRate={setSpeechRate}
      onPreview={handlePreview} onVoicePreview={handleVoicePreview} onSynthesize={handleSynthesize}
    />
  );
};