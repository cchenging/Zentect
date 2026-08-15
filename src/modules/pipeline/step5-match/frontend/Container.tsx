// Module: pipeline/step5-match - Container
// @migrated 阶段三：从 useStore → useStep5Store + useProjectStore + usePipelineStore + useStep2Store + useStep3Store + useStep4Store
// 阶段四：移除 mapPipelineResultToState 的 useStore fallback

import React, { useCallback, useMemo } from "react";
import { useStep5Store } from "../../stores/useStep5Store";
import { useStep1Store } from "../../stores/useStep1Store";
import { useStep2Store } from "../../stores/useStep2Store";
import { useStep3Store } from "../../stores/useStep3Store";
import { useStep4Store } from "../../stores/useStep4Store";
import { usePipelineStore } from "@renderer/store/usePipelineStore";
import { useProjectStore } from "@modules/editor/stores/useProjectStore";
import { API } from "@renderer/api";
import { mapPipelineResultToState } from "@modules/editor/shell/frontend/hooks/usePipelineResultMapper";
import { buildMappers } from "@modules/editor/shell/frontend/hooks/usePipelineOrchestrator";
import { STEP_SEQUENCES } from "@modules/editor/shell/utils/pipelineConstants";
import { persistProjectSnapshot } from "@modules/editor/shell/utils/persistSnapshot";
import { StepShotMatchingView } from "./View";

export const StepShotMatching: React.FC = () => {
  const matchResults = useStep5Store((s) => s.matchResults);
  const activeBgm = useStep5Store((s) => s.activeBgm);
  const videoChunks = useStep5Store((s) => s.videoChunks);
  const confirmMatch = useStep5Store((s) => s.confirmMatch);
  const setMatchResults = useStep5Store((s) => s.setMatchResults);
  /** 步骤4 配音结果：预览弹窗按 shotId 取音频同步播放 */
  const ttsResults = useStep4Store((s) => s.ttsResults);

  const mediaItems = useProjectStore((s) => s.mediaItems);
  const pipelineRunning = usePipelineStore((s) => s.pipelineRunning);
  /** 步骤2 逐帧 VLM 描述（含情绪/景别），P3 用于聚合多模态选曲信号 */
  const vlmFrames = useStep2Store((s) => s.vlmFrames);
  /** 解说文案段落（用于个性化 BGM 推荐的情绪分析） */
  const scriptParagraphs = useStep3Store((s) => s.scriptParagraphs);
  /** 全局情绪基调（用户可在步骤3设定） */
  const emotionTone = useStep3Store((s) => s.pipelineParams?.emotionTone || 'neutral');
  /** 已分离的伴奏音频项（原视频做过人声/BGM 分离后生成），可直接选用为 BGM */
  const bgmOptions = useMemo(
    () => mediaItems.filter((m) => m.type === 'audio' && (m as any).extractedBgm),
    [mediaItems],
  );

  /** P3 多模态：从步骤2 VLM 帧聚合去重的画面情绪标签（帧 emotion 或 downstream.emotion） */
  const frameEmotions = useMemo(() => {
    const set = new Set<string>();
    for (const f of vlmFrames as any[]) {
      const v = String(f?.emotion || f?.downstream?.emotion || '').trim();
      if (v) set.add(v);
    }
    return Array.from(set);
  }, [vlmFrames]);

  /** P3 多模态：从步骤2 VLM 帧聚合去重的镜头景别标签（shotType 或 downstream.shotType） */
  const shotTypes = useMemo(() => {
    const set = new Set<string>();
    for (const f of vlmFrames as any[]) {
      const v = String(f?.shotType || f?.downstream?.shotType || '').trim();
      if (v) set.add(v);
    }
    return Array.from(set);
  }, [vlmFrames]);

  /** P3 多模态：源视频总时长（mediaItems[0].duration 为秒，换算为毫秒） */
  const videoDurationMs = useMemo(() => {
    const d = mediaItems[0]?.duration;
    return typeof d === 'number' && d > 0 ? Math.round(d * 1000) : 0;
  }, [mediaItems]);

  const handleReplace = useCallback((shotId: string, chunkItem: any) => {
    const coverPath = chunkItem.coverPath || chunkItem.filePath || chunkItem.thumbnail;
    const step5State = useStep5Store.getState();
    step5State.replaceMatch(shotId, chunkItem.id);
    const updated = step5State.matchResults.map((m: any) =>
      m.shotId === shotId
        ? { ...m, mediaId: chunkItem.id, thumbnail: coverPath, chunkData: chunkItem.chunkData || chunkItem, confirmed: false }
        : m
    );
    setMatchResults(updated);
  }, [setMatchResults]);

  const handleRematch = useCallback(async () => {
    const projectState = useProjectStore.getState();
    const pipelineState = usePipelineStore.getState();
    const step1State = useStep1Store.getState();
    const step2State = useStep2Store.getState();
    const step3State = useStep3Store.getState();
    const step4State = useStep4Store.getState();
    const step5State = useStep5Store.getState();

    if (!projectState.projectId) return;
    pipelineState.setStepStatus(5, "running");
    pipelineState.setPipelineRunning(true);
    pipelineState.resetPipeline();
    try {
      const sequence = STEP_SEQUENCES[5];
      const enriched = sequence.map((node: any) => ({
        ...node,
        params: {
          ...(node.params || {}),
          mediaPath: projectState.mediaItems?.[0]?.filePath || "",
          scriptShots: step3State.scriptParagraphs || [],
          ttsDurations: step4State.ttsResults || [],
          /** ASR 原声时间轴：原声段落（keepOriginalAudio）按原声文本定位原片时间段 */
          asrLines: step1State.asrLines || [],
          /** 步骤2 逐帧 VLM 描述（带时间戳）：按时间轴聚合到切片，做"文案↔切片描述"文本语义匹配（复用已花成本的画面理解，零额外 VLM 调用） */
          frameDescriptions: step2State.vlmFrames
            .map((f: any) => ({
              timeMs: Number(f.timeMs) || 0,
              description: (f.description || '').trim(),
              /** 🎭 P0 意境维度：帧情绪标签（如：紧张/平静/温馨），聚合为切片情绪标签参与 KM 情绪匹配 */
              emotion: (f.emotion || f.downstream?.emotion || '').trim(),
              /** 🎬 帧景别（如：特写/中景/全景），聚合到切片供意境/衔接匹配 */
              shotType: (f.downstream?.shotType || '').trim(),
            }))
            .filter((f) => f.description.length > 0),
          bgmInfo: step5State.activeBgm ?? null,
        },
      }));
      const result = await API.engine.runPipeline({
        projectId: projectState.projectId,
        sequence: enriched,
        sourceMedia: projectState.mediaItems?.[0]?.filePath || "",
      });
      if (result) mapPipelineResultToState(result?.data || result, buildMappers());
      pipelineState.setStepCompleted(5, true);
      pipelineState.setStepStatus(5, "completed");
      // 💥 根因修复：步骤5独立流程完成时统一落盘，否则匹配结果/切片池/步骤状态
      //   不写入 SQLite，重开项目步骤5状态丢失
      if (projectState.projectId) {
        try {
          await persistProjectSnapshot(projectState.projectId);
        } catch (saveErr) {
          console.error("[步骤5] 镜头匹配落盘失败:", saveErr);
        }
      }
    } catch (err: any) {
      pipelineState.setStepStatus(5, "failed");
      pipelineState.setPipelineError(err?.message || "匹配失败");
    } finally {
      pipelineState.setPipelineRunning(false);
    }
  }, []);

  /** 设置 BGM（从已分离伴奏选择或本地导入共用入口），选中后自动重匹配以应用节拍吸附 */
  const handleSetBgm = useCallback((bgm: { id: string; filePath: string; name?: string; bpm?: number }) => {
    useStep5Store.getState().setActiveBgm(bgm);
    handleRematch();
  }, [handleRematch]);

  /** 移除 BGM，并重匹配回退到无 BGM 模式 */
  const handleRemoveBgm = useCallback(() => {
    useStep5Store.getState().setActiveBgm(null);
    handleRematch();
  }, [handleRematch]);

  /** 上传本地音乐文件为 BGM：弹系统文件选择框 → 构造 BgmInfo → 沿用 handleSetBgm */
  const handleUploadBgm = useCallback(async () => {
    const picked = await API.system.openFile({
      filters: [{ name: '音频文件', extensions: ['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg'] }],
    });
    if (!picked) return;
    const name = picked.split(/[\\/]/).pop() || '本地BGM';
    handleSetBgm({ id: `bgm-upload-${Date.now()}`, filePath: picked, name });
  }, [handleSetBgm]);

  return (
    <StepShotMatchingView
      matchResults={matchResults}
      videoChunks={videoChunks}
      mediaItems={mediaItems}
      ttsResults={ttsResults}
      hasBgm={!!activeBgm}
      isProcessing={pipelineRunning}
      activeBgm={activeBgm}
      scriptParagraphs={scriptParagraphs}
      emotionTone={emotionTone}
      frameEmotions={frameEmotions}
      shotTypes={shotTypes}
      videoDurationMs={videoDurationMs}
      bgmOptions={bgmOptions}
      onSetBgm={handleSetBgm}
      onRemoveBgm={handleRemoveBgm}
      onUploadBgm={handleUploadBgm}
      onConfirm={confirmMatch}
      onReplace={handleReplace}
      onRematch={handleRematch}
      onReorder={setMatchResults}
    />
  );
};
