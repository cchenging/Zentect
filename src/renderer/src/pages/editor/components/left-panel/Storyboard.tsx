import React, { useState, useMemo } from 'react';
import { Camera, Image as ImageIcon, Star, RefreshCw, Headphones, PlayCircle, Edit3, Sparkles, Search, X } from 'lucide-react';
import { useEditorStore } from '../../../../store/useStore';
import type { Shot } from '../../../../../../shared/types';
import { getSafeMediaUrl } from '../../../../utils/formatUrl';
import { AppNotifier } from '../../../../core/AppNotifier';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { useI18n } from '../../../../store/useI18n';
import { API } from '../../../../api';

const ShotCard = React.memo(({ shot, index, isAiMode, isActive, roles, selectItem, handleSingleVision, handleSingleEmotion, handleSingleTTS, handlePlayAudio, loadingVisionId, loadingEmotionId, generatingShotId }: any) => {
  const { t } = useI18n();
  void roles;
  const isGap = !shot.originalText || shot.originalText.trim() === '';
  const frameCount = shot.contextFrames?.length || 0;
  const duration = (shot.end - shot.start).toFixed(1);

  const highlightClass = shot.semanticScore ? 'border-emerald-500/80 bg-emerald-500/5 shadow-md shadow-emerald-500/10' : (isActive ? 'bg-muted border-primary/50 shadow-sm' : 'bg-card border-border hover:border-primary/30');

  const handlePlayClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    handlePlayAudio(shot.audioPath);
  };

  const handleEditClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    selectItem(shot.id, 'shot');
  };

  const handleTTSClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    handleSingleTTS(shot);
  };

  const handleVisionClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    handleSingleVision(shot);
  };

  const handleEmotionClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    handleSingleEmotion(shot);
  };

  const getEmotionClassName = () => {
    let baseClass = 'px-1.5 py-0.5 rounded-sm text-[10px] font-medium border ';
    if (shot.audioEmotion && (shot.audioEmotion.includes('愤怒') || shot.audioEmotion.includes('咆哮'))) {
      return baseClass + 'bg-red-500/10 text-red-500 border-red-500/20';
    } else if (isGap) {
      return baseClass + 'bg-muted text-muted-foreground border-border';
    }
    return baseClass + 'bg-blue-500/10 text-blue-500 border-blue-500/20';
  };

  return (
    <div onClick={() => selectItem(shot.id, 'shot')} className={`flex gap-3 p-3 rounded-lg border cursor-pointer transition-all duration-300 relative ${highlightClass}`}>
      <div className="w-[88px] h-[50px] rounded bg-black overflow-hidden shrink-0 relative border border-border/50">
        {shot.coverPath && <img src={getSafeMediaUrl(shot.coverPath)} className="w-full h-full object-cover" alt="cover" />}
        {frameCount > 0 && <div className="absolute top-1 right-1 text-[10px] text-white bg-black/60 px-1 rounded flex items-center gap-0.5"><Camera size={10} /> {frameCount}</div>}
        <div className="absolute bottom-1 right-1 text-[10px] text-white bg-black/60 px-1 rounded font-mono">{duration}s</div>
      </div>
      
      <div className="flex-1 flex flex-col gap-1.5 pb-6">
         <div className="flex justify-between items-start">
            <span className="text-muted-foreground text-caption font-semibold">
               {isAiMode ? `${t.storyboard?.shot_prefix || '镜'} ${index + 1}` : isGap ? (t.storyboard?.shot_gap || '间隙') : `${t.storyboard?.shot_prefix || '镜'} ${index + 1}`}
            </span>
            {shot.semanticScore !== undefined && (
               <span className="text-[10px] font-bold text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">
                 {t.storyboard?.match_score || '契合'} {(shot.semanticScore * 100).toFixed(0)}%
               </span>
            )}
         </div>

         {!isAiMode && !isGap && <span className="text-foreground text-body font-medium leading-relaxed line-clamp-2">"{shot.originalText}"</span>}
         {isAiMode && <span className="text-foreground text-body font-medium leading-relaxed line-clamp-3">{shot.aiText}</span>}

         {!isAiMode && shot.visionText ? (
             <div className="flex gap-1.5 items-start bg-background/50 p-1.5 rounded-sm border border-border/50 mt-1">
               <ImageIcon className="text-primary mt-0.5 shrink-0" size={12} />
               <span className="text-muted-foreground text-mini italic line-clamp-2 leading-relaxed">{shot.visionText}</span>
             </div>
         ) : !isAiMode && frameCount > 0 ? (
             <Button 
               variant="outline" 
               size="sm" 
               className="h-6 text-mini w-fit px-2 mt-1" 
               disabled={loadingVisionId === shot.id} 
               onClick={handleVisionClick}
             >
               {t.storyboard?.btn_vision_single || '视觉分析'}
             </Button>
         ) : null}

         {!isAiMode && shot.audioEmotion ? (
             <div className="flex flex-wrap gap-1.5 mt-1">
                <span className={getEmotionClassName()}>
                  {shot.audioEmotion}
                </span>
             </div>
         ) : !isAiMode && !isGap ? (
             <Button 
               variant="outline" 
               size="sm" 
               className="h-6 text-mini w-fit px-2 mt-1" 
               disabled={loadingEmotionId === shot.id} 
               onClick={handleEmotionClick}
             >
               {t.storyboard?.btn_emotion_single || '情感识别'}
             </Button>
         ) : null}
      </div>

      {isAiMode && (
         <div className="absolute bottom-2 right-2 flex gap-1">
            {shot.audioPath && (
              <button 
                onClick={handlePlayClick}
                className="w-7 h-7 flex items-center justify-center rounded text-primary hover:bg-primary/10 transition-colors outline-none"
              >
                <PlayCircle size={16}/>
              </button>
            )}
            <button 
              onClick={handleEditClick}
              className="w-7 h-7 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors outline-none"
            >
              <Edit3 size={16}/>
            </button>
            <button 
              disabled={generatingShotId === shot.id} 
              onClick={handleTTSClick}
              className="w-7 h-7 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors outline-none"
            >
              {generatingShotId === shot.id ? (
                <div className="w-3.5 h-3.5 rounded-full border-2 border-t-transparent border-foreground animate-spin"/>
              ) : (
                <RefreshCw size={16}/>
              )}
            </button>
         </div>
      )}
    </div>
  );
});

export const Storyboard: React.FC = () => {
  const { t } = useI18n();
  const projectId = useEditorStore(s => s.projectId);
  const mediaItemsStore = useEditorStore(s => s.mediaItems);
  // 💥 防御性编程：确保 mediaItems 是数组
  const mediaItems = Array.isArray(mediaItemsStore) ? mediaItemsStore : [];
  const shots = useEditorStore(s => s.shots);
  const aiShots = useEditorStore(s => s.aiShots);
  const roles = useEditorStore(s => s.roles);
  const updateShot = useEditorStore(s => s.updateShot);
  const storyboardMode = useEditorStore(s => s.storyboardMode);
  const setStoryboardMode = useEditorStore(s => s.setStoryboardMode);
  const selectedItemId = useEditorStore(s => s.selectedItemId);
  const selectItem = useEditorStore(s => s.selectItem);

  const activeRoleFilter = useEditorStore(s => s.activeRoleFilter);
  const setActiveRoleFilter = useEditorStore(s => s.setActiveRoleFilter);
  const semanticSearchResults = useEditorStore(s => s.semanticSearchResults);
  const setSemanticSearchResults = useEditorStore(s => s.setSemanticSearchResults);

  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);

  const [isGenerating, setIsGenerating] = useState(false);
  const [isGlobalTTS, setIsGlobalTTS] = useState(false);
  const [generatingShotId, setGeneratingShotId] = useState<string | null>(null);
  const [loadingVisionId, setLoadingVisionId] = useState<string | null>(null);
  const [loadingEmotionId, setLoadingEmotionId] = useState<string | null>(null);
  const [isGlobalVisionLoading, setIsGlobalVisionLoading] = useState(false);
  const [isGlobalEmotionLoading, setIsGlobalEmotionLoading] = useState(false);

  const activeShots = storyboardMode === 'original' ? shots : aiShots;

  const displayShots = useMemo(() => {
    let result = activeShots;
    if (activeRoleFilter) {
      result = result.filter(s => (s as any).clusterIds?.includes(activeRoleFilter));
    }
    if (semanticSearchResults && semanticSearchResults.length > 0) {
      const scoreMap = Object.fromEntries(semanticSearchResults.map(r => [r.shotId, r.score]));
      result = result
        .filter(s => scoreMap[s.id] !== undefined)
        .map(s => ({ ...s, semanticScore: scoreMap[s.id] }))
        .sort((a, b) => (b.semanticScore || 0) - (a.semanticScore || 0)); 
    }
    return result;
  }, [activeShots, activeRoleFilter, semanticSearchResults]);

  const handlePlayAudio = (audioPath?: string) => {
    if (!audioPath) return AppNotifier.warn('音频路径不存在');
    const safeUrl = getSafeMediaUrl(audioPath);
    new Audio(safeUrl).play().catch(e => AppNotifier.error(e.message));
  };

  const handleSingleVision = async (shot: Shot) => {
    setLoadingVisionId(shot.id);
    try {
      const res: any = await API.ai.visionSingle({ shot });
      updateShot(shot.id, { visionText: res.visionText });
    } catch (e: any) { AppNotifier.error(e.message); }
    finally { setLoadingVisionId(null); }
  };

  const handleSingleEmotion = async (shot: Shot) => {
    setLoadingEmotionId(shot.id);
    try {
      const mainMedia = mediaItems.find(m => m.id === shot.mediaId) || mediaItems.find(m => m.type === 'video');
      const res: any = await API.ai.emotionSingle({ shot, mediaPath: mainMedia?.filePath });
      updateShot(shot.id, { audioEmotion: res.audioEmotion });
    } catch (e: any) { AppNotifier.error(e.message); }
    finally { setLoadingEmotionId(null); }
  };

  const isDirtyErrorData = (text?: string) => {
    if (!text) return true;
    const tl = text.toLowerCase();
    return tl.includes('异常') || tl.includes('崩溃') || tl.includes('error');
  };

  const handleGlobalVision = async () => {
    setIsGlobalVisionLoading(true);
    let count = 0;
    for (const shot of shots) {
      if (!isDirtyErrorData(shot.visionText) || !shot.contextFrames || shot.contextFrames.length === 0) continue;
      try {
        const res: any = await API.ai.visionSingle({ shot });
        updateShot(shot.id, { visionText: res.visionText });
        count++;
      } catch (e) { }
    }
    setIsGlobalVisionLoading(false);
    if (count > 0) AppNotifier.success(`补充完成 ${count} 镜视觉描述`);
  };

  const handleGlobalEmotion = async () => {
    setIsGlobalEmotionLoading(true);
    let count = 0;
    for (const shot of shots) {
      if (!isDirtyErrorData(shot.audioEmotion) || !shot.originalText || shot.originalText.trim() === '') continue;
      try {
        const mainMedia = mediaItems.find(m => m.id === shot.mediaId) || mediaItems.find(m => m.type === 'video');
        const res: any = await API.ai.emotionSingle({ shot, mediaPath: mainMedia?.filePath });
        updateShot(shot.id, { audioEmotion: res.audioEmotion });
        count++;
      } catch (e) {}
    }
    setIsGlobalEmotionLoading(false);
    if (count > 0) AppNotifier.success(`补充完成 ${count} 镜情感分析`);
  };

  const handleAIBreakthrough = async () => {
    const mainMedia = mediaItems.find(m => m.type === 'video');
    if (!mainMedia) return AppNotifier.warn('未找到有效视频资产');
    if (shots.length === 0) return AppNotifier.warn('BIZ_TRACK_EMPTY');
    
    setIsGenerating(true);
    try {
      // 💥 宪法核心：从单一事实来源(Zustand)提取语种，传递给 AI 大脑
      const targetLanguage = useEditorStore.getState().extractionConfig.targetLanguage || 'zh-CN';
      
      const res: any = await API.ai.generateAiScript({ 
        projectId, 
        mediaPath: mainMedia.filePath, 
        originalShots: shots, 
        mediaId: mainMedia.id, 
        roles,
        targetLanguage // 💥 射出巴别塔引信
      });
      useEditorStore.getState().hydrateProjectData({ aiShots: res.aiShots });
      setStoryboardMode('ai');
      AppNotifier.success('TASK_GENERATE_SUCCESS');
    } catch (e: any) { AppNotifier.error(e.message); }
    finally { setIsGenerating(false); }
  };

  const handleSingleTTS = async (shot: Shot) => {
    setGeneratingShotId(shot.id);
    try {
      const res: any = await API.ai.runSingleTTS(projectId || '', shot);
      if (storyboardMode === 'ai') {
        const newAiShots = aiShots.map(s => s.id === shot.id ? { ...s, audioPath: res.audioPath, audioDuration: res.audioDuration, end: shot.start + res.audioDuration } : s);
        useEditorStore.setState({ aiShots: newAiShots });
      } else {
        updateShot(shot.id, { audioPath: res.audioPath, audioDuration: res.audioDuration, end: shot.start + res.audioDuration });
      }
      AppNotifier.success('AI_TTS_SUCCESS');
    } catch (e: any) { AppNotifier.error(e.message); }
    finally { setGeneratingShotId(null); }
  };

  const handleGlobalTTS = async () => {
    setIsGlobalTTS(true);
    try {
      const targetShots = storyboardMode === 'ai' ? aiShots : shots;
      const res: any = await API.ai.runGlobalTTS(projectId || '', targetShots);
      if (storyboardMode === 'ai') {
        useEditorStore.setState({ aiShots: res.updatedShots });
      } else {
        useEditorStore.setState({ shots: res.updatedShots });
      }
      AppNotifier.success('AI_TTS_SUCCESS');
    } catch (e: any) { AppNotifier.error(e.message); }
    finally { setIsGlobalTTS(false); }
  };

  const handleApplyToTimeline = async () => {
    try {
       useEditorStore.setState({ shots: [...aiShots] });
       AppNotifier.success('BIZ_SAVE_SUCCESS');
       setStoryboardMode('original');
    } catch (e: any) { AppNotifier.error(e.message); }
  };

  const executeSemanticSearch = async () => {
    if (!searchQuery.trim()) return setSemanticSearchResults(null);
    const mainMedia = mediaItems.find(m => m.type === 'video');
    if (!mainMedia) return AppNotifier.warn('请先导入视频资产');

    setIsSearching(true);
    try {
      const results = await API.ai.searchSemantics(mainMedia.id, searchQuery);
      setSemanticSearchResults(results);
    } catch (e: any) {
      AppNotifier.error(t.errors?.[e.message] || e.message);
      setSemanticSearchResults(null);
    } finally {
      setIsSearching(false);
    }
  };

  const clearSearch = () => {
    setSearchQuery('');
    setSemanticSearchResults(null);
  };

  return (
    <div className="animate-in fade-in flex flex-col h-full overflow-hidden">
      
      <div className="flex flex-col gap-2 pb-2 border-b border-border shrink-0 px-2 pt-2">
        
        <div className="flex bg-muted p-1 rounded-md">
          <button onClick={() => setStoryboardMode('original')} className={`flex-1 py-1 text-caption font-medium rounded-sm transition-all ${storyboardMode === 'original' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'}`}>
            {t.storyboard?.mode_original || '原生分镜'} ({shots.length})
          </button>
          <button onClick={() => setStoryboardMode('ai')} className={`flex-1 py-1 text-caption font-medium rounded-sm transition-all ${storyboardMode === 'ai' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'}`}>
            {t.storyboard?.mode_ai || 'AI 二创'} ({aiShots.length})
          </button>
        </div>

        {storyboardMode === 'original' && shots.length > 0 && (
          <div className="flex gap-2 pt-1">
            <Button variant="outline" size="sm" className="flex-1 h-8 text-[11px] gap-1.5" disabled={isGlobalVisionLoading} onClick={handleGlobalVision}>
              {isGlobalVisionLoading ? <div className="w-3 h-3 rounded-full border-2 border-t-transparent border-primary animate-spin" /> : <Camera size={14} />}{t.storyboard?.btn_vision_all || '全量视觉'}
            </Button>
            <Button variant="outline" size="sm" className="flex-1 h-8 text-[11px] gap-1.5" disabled={isGlobalEmotionLoading} onClick={handleGlobalEmotion}>
              {isGlobalEmotionLoading ? <div className="w-3 h-3 rounded-full border-2 border-t-transparent border-primary animate-spin" /> : <Headphones size={14} />}{t.storyboard?.btn_emotion_all || '全量情感'}
            </Button>
          </div>
        )}

        {storyboardMode === 'ai' && aiShots.length > 0 && (
          <div className="flex gap-2 pt-1">
            <Button variant="outline" size="sm" className="flex-1 h-8 text-[11px] gap-1" disabled={isGenerating} onClick={handleAIBreakthrough}>
              {isGenerating ? <div className="w-3 h-3 rounded-full border-2 border-t-transparent border-primary animate-spin" /> : <RefreshCw size={14} />}{t.storyboard?.btn_remake || '重置AI'}
            </Button>
            <Button size="sm" className="flex-1 h-8 text-[11px] gap-1 shadow-sm" disabled={isGlobalTTS} onClick={handleGlobalTTS}>
              {isGlobalTTS ? <div className="w-3 h-3 rounded-full border-2 border-t-transparent border-white animate-spin" /> : <Headphones size={14} />}{t.storyboard?.btn_tts_all || '全量配音'}
            </Button>
            <Button size="sm" onClick={handleApplyToTimeline} className="flex-1 h-8 text-[11px] gap-1 bg-[#E5C158] hover:bg-[#E5C158]/90 text-black font-semibold shadow-sm border-none">
              <Sparkles size={14} />{t.storyboard?.btn_apply || '覆盖轨道'}
            </Button>
          </div>
        )}

        {roles.length > 0 && (
          <div className="flex gap-2 overflow-x-auto py-1 scrollbar-hide items-center mt-1">
             <div 
               onClick={() => setActiveRoleFilter(null)}
               className={`shrink-0 px-3 h-7 flex items-center justify-center rounded-full text-[10px] cursor-pointer transition-all border ${!activeRoleFilter ? 'bg-primary text-primary-foreground border-primary shadow-md' : 'bg-muted border-border hover:bg-muted/80 text-muted-foreground'}`}
             >
               {t.storyboard?.role_all || '全阵容'}
             </div>
             {roles.map(role => (
                <div 
                  key={role.systemId}
                  onClick={() => setActiveRoleFilter(role.systemId)}
                  className={`shrink-0 flex items-center gap-1.5 h-7 pl-1 pr-2.5 rounded-full cursor-pointer transition-all border ${activeRoleFilter === role.systemId ? 'bg-primary/10 border-primary text-primary shadow-sm' : 'bg-card border-border hover:border-primary/50 text-foreground'}`}
                >
                  <img src={getSafeMediaUrl(role.avatar || '')} className="w-5 h-5 rounded-full object-cover bg-black" alt="" />
                  <span className="text-[10px] font-medium max-w-[60px] truncate">{role.name}</span>
                </div>
             ))}
          </div>
        )}

        <div className="relative mt-1">
          <Input 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && executeSemanticSearch()}
            placeholder={t.storyboard?.search_placeholder || '输入画面描述进行跨模态检索...'}
            className="h-8 pl-8 pr-8 text-[11px] bg-muted/50 border-border focus-visible:ring-primary focus-visible:bg-background"
          />
          {isSearching ? (
             <div className="absolute left-2.5 top-2.5 w-3 h-3 rounded-full border-2 border-t-transparent border-primary animate-spin" />
          ) : (
             <Search size={14} className="absolute left-2.5 top-2 text-muted-foreground" />
          )}
          {searchQuery && (
            <button onClick={clearSearch} className="absolute right-2 top-1.5 p-0.5 rounded-full hover:bg-muted-foreground/20 text-muted-foreground transition-colors">
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col gap-2 pt-2 px-2 pb-4">
        {displayShots.length > 0 ? (
          displayShots.map((shot, index) => (
            <ShotCard
              key={shot.id}
              shot={shot}
              index={index}
              isAiMode={storyboardMode === 'ai'}
              isActive={selectedItemId === shot.id}
              roles={roles}
              selectItem={selectItem}
              handleSingleVision={handleSingleVision}
              handleSingleEmotion={handleSingleEmotion}
              handleSingleTTS={handleSingleTTS}
              handlePlayAudio={handlePlayAudio}
              loadingVisionId={loadingVisionId}
              loadingEmotionId={loadingEmotionId}
              generatingShotId={generatingShotId}
            />
          ))
        ) : (
          <div className="flex-1 flex flex-col justify-center items-center opacity-50 pt-10">
            {storyboardMode === 'ai' ? (
              <>
                 <Star size={48} className="text-primary mb-3 drop-shadow-md opacity-80" />
                 <span className="text-body font-semibold">{t.storyboard?.ai_empty_title || '尚未生成 AI 剧本'}</span>
                 <Button disabled={isGenerating} onClick={handleAIBreakthrough} className="mt-4 gap-2 shadow-md">一键重铸爆款解说</Button>
              </>
            ) : (
              <>
                 <Search size={32} className="mb-2" />
                 <span className="text-caption">{t.storyboard?.empty_search || '无匹配镜头'}</span>
              </>
            )}
          </div>
        )}
      </div>

    </div>
  );
};
