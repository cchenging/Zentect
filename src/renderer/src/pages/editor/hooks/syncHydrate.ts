/**
 * syncHydrate — hydrateProjectData 完成后的本地 Store 同步工具
 *
 * @description
 * 解决 useEditorHydration 只向主 Store (dataSlice) 写数据，
 * 7 个本地 Store 在项目重进后仍然是空初始状态的问题。
 *
 * 两个导出函数：
 * - resetAllLocalStores()：进场第一毫秒清空所有本地 Store
 * - syncHydratedStateToStores()：hydrate 完成后从主 Store 推送到各本地 Store
 */

import { useEditorStore } from '../../../store/useStore';
import { useProjectStore } from '../../../../../modules/editor/stores/useProjectStore';
import { usePipelineStore } from '../../../store/usePipelineStore';
import { useStep1Store } from '../../../../../modules/pipeline/stores/useStep1Store';
import { useStep2Store } from '../../../../../modules/pipeline/stores/useStep2Store';
import { useStep3Store } from '../../../../../modules/pipeline/stores/useStep3Store';
import { useStep4Store } from '../../../../../modules/pipeline/stores/useStep4Store';
import { useStep5Store } from '../../../../../modules/pipeline/stores/useStep5Store';
import { useEditorNavStore } from '../../../../../modules/editor/stores/useEditorNavStore';

/** 防御性数组取值 */
const safeArray = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);

/** 防御性 Record 取值 */
const safeRecord = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};

/**
 * 重置所有本地 Store 到初始状态
 * 防止切换项目后旧数据残留
 */
export function resetAllLocalStores(): void {
  // --- useProjectStore ---
  const projectStore = useProjectStore.getState();
  if (typeof projectStore.resetProjectState === 'function') {
    projectStore.resetProjectState();
  }

  // --- usePipelineStore ---
  const ps = usePipelineStore.getState();
  if (typeof ps.resetAllStepStatuses === 'function') ps.resetAllStepStatuses();
  usePipelineStore.setState({ stepCompleted: [false, false, false, false, false] });
  if (typeof ps.setPipelineRunning === 'function') ps.setPipelineRunning(false);
  if (typeof ps.setPipelineProgress === 'function') ps.setPipelineProgress(0, '');
  if (typeof ps.setPipelineError === 'function') ps.setPipelineError(null);
  if (typeof ps.setExtractionConfig === 'function') ps.setExtractionConfig(null);

  // --- useStep1Store (无完整 reset，逐个调用 setter) ---
  const s1 = useStep1Store.getState();
  if (typeof s1.setAsrLines === 'function') s1.setAsrLines([]);
  if (typeof s1.setFrameCount === 'function') s1.setFrameCount(0);
  if (typeof s1.setAudioSeparated === 'function') s1.setAudioSeparated(false);
  if (typeof s1.setSubStepStatus === 'function') {
    s1.setSubStepStatus('frames', 'idle');
    s1.setSubStepStatus('audio', 'idle');
    s1.setSubStepStatus('whisper', 'idle');
    s1.setSubStepStatus('faces', 'idle');
  }
  useStep1Store.setState({
    subStepProgresses: {} as Record<string, number>,
    extractionConfig: null as any,
  });

  // --- useStep2Store ---
  const s2 = useStep2Store.getState();
  if (typeof s2.setVlmFrames === 'function') s2.setVlmFrames([]);

  // --- useStep3Store (无完整 reset，逐个调用 setter) ---
  const s3 = useStep3Store.getState();
  if (typeof s3.setScriptParagraphs === 'function') s3.setScriptParagraphs([]);
  if (typeof s3.setScriptStyle === 'function') s3.setScriptStyle('赛博现实主义');
  if (typeof s3.setSpeechRate === 'function') s3.setSpeechRate(4.5);
  if (typeof s3.setPipelineParams === 'function') s3.setPipelineParams({ R: 70, S: 50, T: 80, P: 60 });

  // --- useStep4Store ---
  const s4 = useStep4Store.getState();
  if (typeof s4.setTtsEngine === 'function') s4.setTtsEngine('edge');
  if (typeof s4.setTtsVoiceId === 'function') s4.setTtsVoiceId('');
  if (typeof s4.setTtsProgress === 'function') s4.setTtsProgress(0);
  if (typeof s4.setTtsResults === 'function') s4.setTtsResults([]);

  // --- useStep5Store ---
  const s5 = useStep5Store.getState();
  if (typeof s5.setMatchResults === 'function') s5.setMatchResults([]);
  if (typeof s5.setActiveBgm === 'function') s5.setActiveBgm(null);
  if (typeof s5.setBeatTimestamps === 'function') s5.setBeatTimestamps([]);
  if (typeof s5.setVideoChunks === 'function') s5.setVideoChunks([]);

  // --- useEditorNavStore ---
  const nav = useEditorNavStore.getState();
  if (typeof nav.setCurrentStep === 'function') nav.setCurrentStep(1);
  if (typeof nav.setIsAutoMode === 'function') nav.setIsAutoMode(false);
}

/**
 * 从主 Store (useEditorStore) 读取 hydrate 后的数据，推送到各本地 Store
 * 必须在 hydrateProjectData 执行完成后调用，确保主 Store 数据已就绪
 */
export function syncHydratedStateToStores(projectSnapshot: any): void {
  const main = useEditorStore.getState();

  // ─── useProjectStore ───
  const projectStore = useProjectStore.getState();
  if (main.projectId && main.projectName && typeof projectStore.setProjectMeta === 'function') {
    projectStore.setProjectMeta(main.projectId, main.projectName);
  }
  const mediaItems = safeArray<any>(main.mediaItems);
  if (typeof projectStore.setMediaItems === 'function') {
    projectStore.setMediaItems(mediaItems);
  }
  const shots = safeArray<any>(main.shots);
  useProjectStore.setState({ shots });
  const aiShots = safeArray<any>(main.aiShots);
  if (typeof projectStore.setAiShots === 'function') {
    projectStore.setAiShots(aiShots);
  }
  const roles = safeArray<any>(main.roles);
  useProjectStore.setState({ roles });
  if (main.extractedData && typeof projectStore.setExtractedData === 'function') {
    projectStore.setExtractedData(main.extractedData);
  }

  // ─── usePipelineStore ───
  const ps = usePipelineStore.getState();
  const stepStatuses = safeArray(main.stepStatuses);
  for (let i = 1; i <= 5; i++) {
    if (typeof ps.setStepStatus === 'function') {
      ps.setStepStatus(i, (stepStatuses[i - 1] as any) || 'idle');
    }
  }
  const stepCompleted = safeArray<boolean>(main.stepCompleted);
  for (let i = 1; i <= 5; i++) {
    if (typeof ps.setStepCompleted === 'function') {
      ps.setStepCompleted(i, !!stepCompleted[i - 1]);
    }
  }
  const subStepStatuses = safeRecord(main.subStepStatuses);
  if (typeof ps.setSubStepStatus === 'function') {
    for (const [key, status] of Object.entries(subStepStatuses)) {
      ps.setSubStepStatus(key, (status as string) || 'idle');
    }
  }
  const subStepProgresses = safeRecord(main.subStepProgresses);
  if (typeof ps.setSubStepProgress === 'function') {
    for (const [key, progress] of Object.entries(subStepProgresses)) {
      ps.setSubStepProgress(key, typeof progress === 'number' ? progress : 0);
    }
  }
  if (projectSnapshot.pipelineParams && typeof ps.setPipelineParams === 'function') {
    ps.setPipelineParams(projectSnapshot.pipelineParams as any);
  }
  if (projectSnapshot.extractionConfig !== undefined && typeof ps.setExtractionConfig === 'function') {
    ps.setExtractionConfig(projectSnapshot.extractionConfig as any);
  }

  // ─── useStep1Store ───
  const s1 = useStep1Store.getState();
  if (typeof s1.setAsrLines === 'function') s1.setAsrLines(safeArray(projectSnapshot.asrLines));
  if (typeof s1.setFrameCount === 'function') s1.setFrameCount(projectSnapshot.frameCount ?? 0);
  if (typeof s1.setAudioSeparated === 'function') s1.setAudioSeparated(!!projectSnapshot.audioSeparated);
  if (typeof s1.setSubStepStatus === 'function') {
    for (const [key, status] of Object.entries(safeRecord(main.subStepStatuses))) {
      s1.setSubStepStatus(key, (status as string) || 'idle');
    }
  }
  if (typeof s1.setSubStepProgress === 'function') {
    for (const [key, progress] of Object.entries(safeRecord(main.subStepProgresses))) {
      s1.setSubStepProgress(key, typeof progress === 'number' ? progress : 0);
    }
  }
  if (projectSnapshot.extractionConfig && typeof s1.updateExtractionConfig === 'function') {
    s1.updateExtractionConfig(projectSnapshot.extractionConfig as any);
  } else if (projectSnapshot.extractionConfig) {
    useStep1Store.setState({ extractionConfig: projectSnapshot.extractionConfig as any });
  }

  // ─── useStep2Store ───
  const s2 = useStep2Store.getState();
  if (typeof s2.setVlmFrames === 'function') s2.setVlmFrames(safeArray(projectSnapshot.vlmFrames));

  // ─── useStep3Store ───
  const s3 = useStep3Store.getState();
  if (typeof s3.setScriptParagraphs === 'function') {
    s3.setScriptParagraphs(safeArray(projectSnapshot.scriptParagraphs));
  }
  if (projectSnapshot.scriptStyle && typeof s3.setScriptStyle === 'function') {
    s3.setScriptStyle(projectSnapshot.scriptStyle as string);
  }
  if (projectSnapshot.speechRate !== undefined && typeof s3.setSpeechRate === 'function') {
    s3.setSpeechRate(Number(projectSnapshot.speechRate) || 4.5);
  }
  if (projectSnapshot.pipelineParams && typeof s3.setPipelineParams === 'function') {
    s3.setPipelineParams(projectSnapshot.pipelineParams as any);
  }

  // ─── useStep4Store ───
  const s4 = useStep4Store.getState();
  if (typeof s4.setTtsResults === 'function') s4.setTtsResults(safeArray(projectSnapshot.ttsResults));
  if (projectSnapshot.ttsEngine && typeof s4.setTtsEngine === 'function') {
    s4.setTtsEngine(projectSnapshot.ttsEngine as string);
  }
  if (projectSnapshot.ttsVoiceId !== undefined && typeof s4.setTtsVoiceId === 'function') {
    s4.setTtsVoiceId((projectSnapshot.ttsVoiceId as string) || '');
  }

  // ─── useStep5Store ───
  const s5 = useStep5Store.getState();
  if (typeof s5.setVideoChunks === 'function') s5.setVideoChunks(safeArray(projectSnapshot.videoChunks));

  // ─── useEditorNavStore ───
  const nav = useEditorNavStore.getState();
  if (main.currentStep !== undefined && typeof nav.setCurrentStep === 'function') {
    nav.setCurrentStep(Number(main.currentStep) || 1);
  }
}
