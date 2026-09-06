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
import { AppNotifier } from "@renderer/core/AppNotifier";
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

  /** 🔧 替换/确认等手动改动后立即落盘：步骤5 结果改动不入 useEditorAutoSave 的 dirty 监听，
   *  且不触发重匹配的显式落盘——若不即时写库，重开项目/导出（读 DB metadata）都会读到旧结果。 */
  const persistStep5Now = useCallback(() => {
    const pid = useProjectStore.getState().projectId;
    if (!pid) return;
    persistProjectSnapshot(pid).catch((e) => console.error("[步骤5] 手动改动落盘失败:", e));
  }, []);

  /** 确认匹配后同样立即落盘（store.confirmMatch 只改内存态） */
  const handleConfirm = useCallback((shotId: string) => {
    confirmMatch(shotId);
    persistStep5Now();
  }, [confirmMatch, persistStep5Now]);

  const handleReplace = useCallback((shotId: string, chunkItem: any) => {
    const coverPath = chunkItem.coverPath || chunkItem.filePath || chunkItem.thumbnail;
    const step5State = useStep5Store.getState();
    step5State.replaceMatch(shotId, chunkItem.id);
    const updated = step5State.matchResults.map((m: any) =>
      /** ✅ 身份键统一：消费端一律读 id（出生处即段落唯一主键） */
      m.id === shotId
        ? { ...m, mediaId: chunkItem.id, thumbnail: coverPath, chunkData: chunkItem.chunkData || chunkItem, confirmed: false }
        : m
    );
    setMatchResults(updated);
    persistStep5Now();
  }, [setMatchResults, persistStep5Now]);

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
    /** 🔧 新匹配开始：清空上一次匹配诊断（避免旧 warning 残留，等新结果返回再写入） */
    step5State.setMatchDiagnostics(null);
    try {
      const sequence = STEP_SEQUENCES[5];
      const enriched = sequence.map((node: any) => ({
        ...node,
        params: {
          ...(node.params || {}),
          mediaPath: projectState.mediaItems?.[0]?.filePath || "",
          /** 🎬 素材 id 必传（2026-09-04）：OP/ED 裁剪配置按素材 id 存于 projects.extraction_config.mediaTrim.perMedia，
           *  缺 mediaId → resolveForMedia 解析不到 trim → needTrim=false → 方向3 直接复用历史"全片含片头"切片池，
           *  导致片头/出品帧始终进匹配与导出（"改了没变"的根因）。补齐后走正剧(body)切片。 */
          mediaId: projectState.mediaItems?.[0]?.id || (projectState.mediaItems?.[0] as any)?.assetId || "",
          /** 🎬 切片池复用（方向3）：回传本店已保存的本项目切片池（step5State.videoChunks ← 上次步骤5 结果），
           *  后端 SemanticAnalyzeStrategy 优先复用免重切；漏传会导致 ownPool 为空 → 依赖 DB 缓存
           *  （旧缓存 key 不兼容时强制重切片 80s+，极端环境失败即"匹配不到任何切片"）。 */
          videoChunks: step5State.videoChunks || [],
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

  /** 🔧 2026-09-05：清空当前视频切片缓存（SQLite video_chunk_parts/video_chunks + 前端复用池），
   *  再触发一次完整 rematch。只清当前项目+当前媒体相关的 key（其它项目前缀不受影响）。 */
  const handleClearCacheAndRematch = useCallback(async () => {
    const projectState = useProjectStore.getState();
    const step5State = useStep5Store.getState();
    const projectId = projectState.projectId;
    const mediaPath = projectState.mediaItems?.[0]?.filePath || "";
    if (!projectId || !mediaPath) {
      AppNotifier.error("缺少项目或视频信息，无法清空切片缓存");
      return;
    }
    try {
      const res = await API.engine.clearChunkCache(projectId, mediaPath);
      if (!res?.success) {
        AppNotifier.error(res?.message || "清空切片缓存失败");
        return;
      }
      /** 前端同步清空复用池与旧匹配结果：方向3 ownPool 优先级高于 DB 缓存，
       *  不清空会继续"利用旧切片"（needTrim 项目不启 ownPool，但无 trim 项目会）；
       *  旧结果清空后由 rematch 的全新结果覆盖，不落盘空态。 */
      step5State.setMatchResults([]);
      step5State.setVideoChunks([]);
      step5State.setMatchDiagnostics(null);
      AppNotifier.success(res.message || "已清空切片缓存", 2200);
      await handleRematch();
    } catch (err: any) {
      AppNotifier.error(`清空切片缓存失败: ${err?.message || err}`);
    }
  }, [handleRematch]);

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
      onConfirm={handleConfirm}
      onReplace={handleReplace}
      onRematch={handleRematch}
      onClearCacheAndRematch={handleClearCacheAndRematch}
      onReorder={setMatchResults}
    />
  );
};
