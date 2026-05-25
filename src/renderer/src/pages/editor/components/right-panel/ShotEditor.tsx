// 📁 路径：src/renderer/src/pages/editor/components/right-panel/ShotEditor.tsx
import React, { useState, useEffect } from 'react';
import { Sparkles, Mic, FileText, Eye, Volume2, Clock, Languages, LayoutGrid, Loader2 } from 'lucide-react';
import { useEditorStore } from '../../../../store/useStore';
import { useI18n } from '../../../../store/useI18n';
import { API } from '../../../../api';
import { AppNotifier } from '../../../../core/AppNotifier';
import { ContextCompressor } from '../../../../core/ContextCompressor';
import { ActionParser } from '../../../../core/ActionParser';
import { IPC_CHANNELS } from '../../../../../../shared/utils/IpcConstants';
import { Textarea } from '../../../../components/ui/textarea';
import { Input } from '../../../../components/ui/input';
import { Button } from '../../../../components/ui/button';
import { formatTimePrecision } from '../../../../utils/timeUtils';
import { FrontendLogger } from '../../../../utils/logger';
// 💥 新增：引入强类型契约
import type { Shot } from '../../../../../../shared/types';

const CONSTANTS = { MIN_DURATION: 0.5 };

const ShotDurationControl: React.FC<{ shot: Shot, safeDuration: number, commitDuration: (val: string) => void }> = ({ shot, safeDuration, commitDuration }) => {
  const [localDuration, setLocalDuration] = useState(safeDuration.toFixed(1));
  useEffect(() => setLocalDuration(safeDuration.toFixed(1)), [safeDuration]);

  const handleBlur = () => {
    let val = parseFloat(localDuration);
    if (isNaN(val) || val < CONSTANTS.MIN_DURATION) val = CONSTANTS.MIN_DURATION;
    setLocalDuration(val.toFixed(1));
    commitDuration(val.toFixed(1));
  };

  return (
    <div className="flex items-center justify-between border-b border-border pb-4">
      <div className="flex items-center gap-2">
        <Clock size={16} className="text-primary" />
        <span className="text-caption font-mono font-medium text-foreground">{formatTimePrecision(shot.start)} - {formatTimePrecision(shot.end)}</span>
      </div>
      <div className="flex items-center gap-2 px-2 py-1 rounded-md bg-muted border border-border focus-within:border-primary transition-all">
        <Input
          type="number" step="0.1" min={CONSTANTS.MIN_DURATION} value={localDuration}
          onChange={e => setLocalDuration(e.target.value)} onBlur={handleBlur} onKeyDown={e => e.key === 'Enter' && handleBlur()}
          className="w-12 h-6 px-1 border-none bg-transparent shadow-none focus-visible:ring-0 text-right text-caption text-foreground font-mono"
        />
        <span className="text-caption text-muted-foreground font-mono select-none">s</span>
      </div>
    </div>
  );
};

const ShotTextEngine: React.FC<{ shot: Shot, commitChange: (f: string, v: string) => void }> = ({ shot, commitChange }) => {
  const { t } = useI18n(); // 💥 新增：挂载字典探针
  const [localOrig, setLocalOrig] = useState(shot.originalText || '');
  const [localAi, setLocalAi] = useState(shot.aiText || '');

  useEffect(() => {
    setLocalOrig(shot.originalText || '');
    setLocalAi(shot.aiText || '');
  }, [shot]);

  return (
    <div className="flex flex-col gap-4 mt-2">
      <div className="flex flex-col gap-2">
        {/* 💥 2. 替换原视频台词标签 */}
        <label className="text-caption font-medium text-muted-foreground flex items-center gap-2"><FileText size={16} /> {t.editor?.prop_original_text || '原视频台词'}</label>
        <Textarea
          value={localOrig} onChange={(e) => setLocalOrig(e.target.value)} onBlur={() => commitChange('originalText', localOrig)}
          className="w-full min-h-[80px] p-3 bg-background border border-border text-caption text-foreground resize-y leading-relaxed"
        />
      </div>
      <div className="flex flex-col gap-2">
        {/* 💥 3. 替换 AI 文案标签 */}
        <label className="text-caption font-medium text-primary flex items-center gap-2"><Sparkles size={16} /> {t.editor?.prop_ai_text || 'AI 二创文案'}</label>
        <Textarea
          value={localAi} onChange={(e) => setLocalAi(e.target.value)} onBlur={() => commitChange('aiText', localAi)}
          className="w-full min-h-[80px] p-3 bg-primary/5 border border-primary/30 text-caption text-foreground focus-visible:ring-1 resize-y leading-relaxed"
        />
      </div>
    </div>
  );
};

export const ShotEditor: React.FC<{ shot: Shot }> = ({ shot }) => {
  const { t } = useI18n();
  const [isGenerating, setIsGenerating] = useState(false);
  const [isAiProcessing, setIsAiProcessing] = useState(false);

  const projectId = useEditorStore(s => s.projectId);
  const shots = useEditorStore(s => s.shots);
  const aiShots = useEditorStore(s => s.aiShots);
  const storyboardMode = useEditorStore(s => s.storyboardMode);
  const updateShot = useEditorStore(s => s.updateShot);
  const updateAiShot = useEditorStore(s => s.updateAiShot);
  const reorderShot = useEditorStore(s => s.reorderShot);

  const activeShots = storyboardMode === 'ai' ? aiShots : shots;

  // 🌟 核心：一键触发 AI 工作流引擎
  const triggerAiAction = async (intent: 'rewrite' | 'translate' | 'reorder' | 'tts') => {
    if (activeShots.length === 0) return AppNotifier.warn('时间轴为空，请先添加素材');
    
    setIsAiProcessing(true);
    try {
      // 💡 针对配音任务的特殊处理
      if (intent === 'tts') {
        const response = await window.api.ipc.invoke(IPC_CHANNELS.AI_RUN_GLOBAL_TTS, projectId, activeShots);
        
        if (response && Array.isArray(response)) {
          // A. 更新 Zustand 原始数据
          if (storyboardMode === 'ai') {
            useEditorStore.setState({ aiShots: response });
          } else {
            useEditorStore.setState({ shots: response });
          }

          // B. 🌟 触发核心物理引擎：多米诺骨牌重排
          // 这个方法会根据每个 shot 最新的 end 时间，重新计算整个时间轴的顺序和对齐
          reorderShot('FORCE_DOMINO_TRIGGER', 0);
          
          AppNotifier.success('全量配音已就位，时间轴已根据音频长度自动对齐！');
        }
        return;
      }

      const context = ContextCompressor.getCompressedSnapshot();
      let prompt = '';

      switch (intent) {
        case 'rewrite':
          prompt = '请用极具网感的解说文案风格，重写当前时间轴上所有镜头的台词。结合画面特征发挥。请输出 UPDATE_TEXT 类型的 JSON 数组。';
          break;
        case 'translate':
          prompt = '请将当前时间轴所有镜头的台词翻译成地道的英文，不要改变原本的语境和时间轴位置。请输出 UPDATE_TEXT 类型的 JSON 数组。';
          break;
        case 'reorder':
          prompt = '请根据时间轴上各镜头的画面内容和台词逻辑，重新排列镜头顺序，使其成为一个流畅的故事。请输出 REORDER 类型的 JSON 数组。';
          break;
      }

      // 呼叫底层 AIEngine 调度工厂
      const response = await window.api.ipc.invoke(IPC_CHANNELS.AI_CHAT_REQUEST, { prompt, context });
      
      if (response.success) {
        // 拿到大模型的 JSON 动作，交由原生物理引擎执行
        const { actions } = ActionParser.extractActions(response.text);
        await ActionParser.executeActions(actions);
      } else {
        AppNotifier.error(`大脑调度失败：${response.error}`);
      }
    } catch (e: any) {
      AppNotifier.error('操作失败：' + e.message);
    } finally {
      setIsAiProcessing(false);
    }
  };

  const safeDuration = Number(shot.duration) || (Number(shot.end) - Number(shot.start)) || 0;

  const commitChange = (field: string, value: string | number) => {
    if (shot[field] === value) return;
    storyboardMode === 'original' ? updateShot(shot.id, { [field]: value }) : updateAiShot(shot.id, { [field]: value });
  };

  const commitDuration = (valStr: string) => {
    const val = parseFloat(valStr);
    if (val === safeDuration) return;
    const updates = { end: shot.start + val };
    storyboardMode === 'original' ? updateShot(shot.id, updates) : updateAiShot(shot.id, updates);
    if (reorderShot) reorderShot(shot.id, shot.start);
    AppNotifier.success((t as any).success?.action_success || '时长已同步至物理轨道');
  };

  const handleGenerateVoice = async () => {
    if (!shot.aiText) return AppNotifier.warning(t.errors?.validation_failed || '文案为空');
    if (!projectId) return AppNotifier.error(t.errors?.action_failed || '工程未就绪');
    
    const traceId = FrontendLogger.generateTraceId();
    FrontendLogger.info('ShotEditor_TTS', 'Generating TTS from inspector', traceId, { shotId: shot.id });
    setIsGenerating(true);
    try {
      const res = await API.ai.runSingleTTS(projectId, shot);
      if (res && res.audioPath) {
        commitChange('audioPath', res.audioPath);
        commitChange('audioDuration', res.audioDuration);
        FrontendLogger.info('ShotEditor_TTS', 'TTS generation successful', traceId, { path: res.audioPath });
        AppNotifier.success(t.editor?.msg_dub_done || 'AI 语音合成完毕');
      }
    } catch (e: any) { 
      FrontendLogger.error('ShotEditor_TTS', 'TTS generation failed', traceId, e.message);
      AppNotifier.error(e.message || t.errors?.action_failed || '语音合成失败'); 
    }
    finally { setIsGenerating(false); }
  };

  return (
    <div className="flex flex-col gap-4 animate-in fade-in duration-300 p-4 box-border h-full relative">
      {/* 🛠 一键创作控制台 (Action Matrix) */}
      <div className="flex items-center gap-2 p-2 border-b border-border bg-muted/30 rounded-md">
        <Button size="sm" variant="outline" className="h-7 text-xs flex-1 gap-1 border-primary/20 text-primary hover:bg-primary/10" onClick={() => triggerAiAction('rewrite')} disabled={isAiProcessing}>
          <Sparkles size={12} /> 网感重写
        </Button>
        <Button size="sm" variant="outline" className="h-7 text-xs flex-1 gap-1" onClick={() => triggerAiAction('translate')} disabled={isAiProcessing}>
          <Languages size={12} /> 巴别塔翻译
        </Button>
        <Button size="sm" variant="outline" className="h-7 text-xs flex-1 gap-1" onClick={() => triggerAiAction('reorder')} disabled={isAiProcessing}>
          <LayoutGrid size={12} /> 智能重组
        </Button>
        <Button size="sm" variant="outline" className="h-7 text-xs flex-1 gap-1" onClick={() => triggerAiAction('tts')} disabled={isAiProcessing}>
          <Volume2 size={12} /> 全量配音
        </Button>
      </div>

      <ShotDurationControl shot={shot} safeDuration={safeDuration} commitDuration={commitDuration} />

      <div className="flex flex-col gap-2">
        {/* 💥 替换解析标题 */}
        <label className="text-caption font-medium text-muted-foreground flex items-center gap-2"><Eye size={16} /> {t.editor?.prop_vision || 'AI 画面解析'}</label>
        <div className="w-full max-h-[80px] overflow-y-auto p-3 bg-card border border-border rounded-md text-caption text-muted-foreground font-mono italic">
          {/* 💥 替换空状态 */}
          {shot.visionText || t.home?.empty_data || '暂无视觉解析数据...'}
        </div>
      </div>

      <ShotTextEngine shot={shot} commitChange={commitChange} />

      <div className="h-px bg-border w-full my-2" />

      <div className="flex items-center justify-between mb-2">
        {/* 💥 替换配音状态文本 */}
        <span className="text-mini text-muted-foreground flex items-center gap-2"><Volume2 size={16} className={shot.audioPath ? 'text-emerald-500' : 'text-muted-foreground'}/> {shot.audioPath ? (t.editor?.msg_dub_done || '已绑定语音') : (t.editor?.status_unvoiced || '尚未配音')}</span>
        <Button onClick={handleGenerateVoice} disabled={isGenerating} size="sm" className="h-8 px-4 text-caption shadow-sm gap-2">
          {/* 💥 替换按钮文字与加载态 */}
          {isGenerating ? <span className="animate-spin text-lg leading-none">⟳</span> : <Mic size={16} />} {isGenerating ? (t.ai_tools?.engine_running || '合成中...') : (t.ai_tools?.standalone_dub || '生成配音')}
        </Button>
      </div>

      {/* 🔒 全局防抖锁定骨架屏 */}
      {isAiProcessing && (
        <div className="absolute inset-0 bg-background/50 backdrop-blur-[2px] z-50 flex flex-col items-center justify-center">
           <Loader2 className="w-8 h-8 animate-spin text-primary mb-3" />
           <p className="text-sm font-medium text-foreground drop-shadow-md">AI 导演正在思考重构方案...</p>
           <p className="text-xs text-muted-foreground mt-1">请勿操作时间轴</p>
        </div>
      )}
    </div>
  );
};