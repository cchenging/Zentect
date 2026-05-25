import { useState, useMemo } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';

import { useEditorStore } from '../../../../store/useStore';
import { getSafeMediaUrl } from '../../../../utils/formatUrl';
import { AppNotifier } from '../../../../core/AppNotifier';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../../components/ui/select';
import { useI18n } from '../../../../store/useI18n';
import { API } from '../../../../api';
import { AppIcon } from '../../../../components/app-icon';

const formatDuration = (seconds: number) => {
  if (!seconds || isNaN(seconds)) return '00:00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

interface ExportModalProps {
  children: React.ReactNode;
}

export const ExportModal: React.FC<ExportModalProps> = ({ children }) => {
  const { t } = useI18n();
  const projectName = useEditorStore(s => s.projectName) || t.editor?.unnamed_project;
  const [modalVisible, setModalVisible] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [currentExportPath, setCurrentExportPath] = useState('');
  
  const [exportVideo, setExportVideo] = useState(true);
  const [exportJianying, setExportJianying] = useState(false);
  const [exportAudio, setExportAudio] = useState(false);
  const [exportSubtitle, _setExportSubtitle] = useState(false);
  const [videoFormat, setVideoFormat] = useState('mp4');
  const [exportRatio, setExportRatio] = useState<'16:9' | '9:16'>('16:9');
  const [videoRes, setVideoRes] = useState<'4k' | '2k' | '1080p' | '720p'>('1080p');
  const [audioFormat, setAudioFormat] = useState('mp3');

  const { coverUrl, currentDuration, exactResolutionStr, estimatedSizeMB } = useMemo(() => {
    if (!modalVisible) return { coverUrl: '', currentDuration: 0, exactResolutionStr: '1920x1080', estimatedSizeMB: '0.0 MB' };
    
    const state = useEditorStore.getState();
    const activeShots = state.storyboardMode === 'ai' ? state.aiShots : state.shots;
    const mediaArray = Array.isArray(state.mediaItems) ? state.mediaItems : [];
    let url = '';
    if (activeShots.length > 0 && mediaArray.length > 0) {
      const firstMedia = mediaArray.find(m => m.id === activeShots[0].mediaId) || mediaArray[0];
      if (firstMedia) url = getSafeMediaUrl(firstMedia.filePath);
    }
    const dur = activeShots.length > 0 ? activeShots[activeShots.length - 1].end : 0;
    const resMap = { '4k': { w: 3840, h: 2160 }, '2k': { w: 2560, h: 1440 }, '1080p': { w: 1920, h: 1080 }, '720p': { w: 1280, h: 720 } };
    const baseRes = resMap[videoRes];
    const width = exportRatio === '9:16' ? baseRes.h : baseRes.w;
    const height = exportRatio === '9:16' ? baseRes.w : baseRes.h;
    const videoBitrate = { '4k': 35000, '2k': 16000, '1080p': 8000, '720p': 5000 }[videoRes] || 8000;
    let sizeMB = ((videoBitrate + 192) * dur) / 8192 * 1.02; 
    return { coverUrl: url, currentDuration: dur, exactResolutionStr: `${width}x${height}`, estimatedSizeMB: sizeMB > 0 ? sizeMB.toFixed(1) + ' MB' : '0.0 MB' };
  }, [modalVisible, videoRes, exportRatio]); 

  const handleOpenClick = async () => {
    const state = useEditorStore.getState();
    const activeShots = state.storyboardMode === 'ai' ? state.aiShots : state.shots;
    if (!activeShots || activeShots.length === 0) { 
      AppNotifier.warn('BIZ_TRACK_EMPTY'); 
      return; 
    }
    const paths = await API.system.getPaths();
    setCurrentExportPath(paths.exports);
    setModalVisible(true);
  };

  const executeExport = async () => {
    if (!exportVideo && !exportJianying && !exportAudio && !exportSubtitle) { 
      AppNotifier.warn('请勾选输出管线'); 
      return; 
    }
    setIsExporting(true);
    try {
      const state = useEditorStore.getState();
      const isAiExport = state.storyboardMode === 'ai';
      const targetShots = isAiExport ? state.aiShots : state.shots;
      if (isAiExport && targetShots.find(s => s.aiText && !s.audioPath)) throw new Error('存在未配音台词，拒绝渲染。');
      const [exactWidth, exactHeight] = exactResolutionStr.split('x').map(Number);
      const payload = { projectId: state.projectId || '', projectName: projectName || '', ratio: exportRatio, resolution: videoRes, exactWidth, exactHeight, shots: JSON.parse(JSON.stringify(targetShots)), mediaItems: JSON.parse(JSON.stringify(state.mediaItems)), isAiMode: isAiExport, activeShots: JSON.parse(JSON.stringify(targetShots)) };
      
      const tasks: Promise<any>[] = [];
      if (exportJianying) tasks.push(API.export.jianying(payload));
      if (exportVideo) tasks.push(API.export.localVideo({ ...payload, format: videoFormat }));
      
      await Promise.all(tasks);
      
      AppNotifier.success('TASK_EXPORT_SUCCESS');
      setModalVisible(false);
    } catch (e: any) { AppNotifier.error(e.message); } finally { setIsExporting(false); }
  };

  return (
    <>
      <div onClick={(e) => { e.stopPropagation(); handleOpenClick(); }}>
        {children}
      </div>

      <DialogPrimitive.Root open={modalVisible} onOpenChange={(open) => !isExporting && setModalVisible(open)}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <DialogPrimitive.Content className="fixed left-[50%] top-[50%] z-[100] w-[580px] translate-x-[-50%] translate-y-[-50%] bg-background border border-border rounded-lg shadow-xl flex flex-col overflow-hidden outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-200">
            <div className="px-4 py-3 border-b border-border flex justify-between items-center bg-muted/30 shrink-0">
              <DialogPrimitive.Title className="m-0 text-body font-semibold text-foreground tracking-wide">{t.export.title}</DialogPrimitive.Title>
              <div className="flex items-center gap-3">
                <span className="text-muted-foreground text-caption">{useEditorStore.getState().storyboardMode === 'ai' ? t.editor?.engine_ai : t.editor?.engine_phy}</span>
                <DialogPrimitive.Close asChild>
                  <button className="bg-transparent border-none text-muted-foreground hover:text-foreground cursor-pointer outline-none p-1 rounded-sm hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring"><AppIcon name="X" size={16} /></button>
                </DialogPrimitive.Close>
              </div>
            </div>

            <div className="flex flex-row h-[340px] bg-background">
              <div className="w-[220px] border-r border-border p-4 overflow-y-auto shrink-0 flex flex-col bg-muted/10">
                <div className="w-full aspect-video bg-black/50 rounded border border-border mb-4 overflow-hidden flex items-center justify-center shrink-0 shadow-inner">
                  {coverUrl ? <img src={coverUrl} alt="Cover" className="w-full h-full object-cover" /> : <span className="text-muted-foreground text-caption">{t.editor?.signal_lost}</span>}
                </div>
                <h6 className="text-foreground m-0 mb-4 text-body break-all font-medium">{projectName}</h6>
                <div className="flex flex-col gap-3">
                  <div className="flex justify-between"><span className="text-muted-foreground text-caption">{t.export.info_duration}</span><span className="text-foreground text-mini font-mono">{formatDuration(currentDuration)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground text-caption">{t.export.info_ratio}</span><span className="text-foreground text-mini">{exportRatio}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground text-caption">{t.export.info_resolution}</span><span className="text-foreground text-mini">{exactResolutionStr}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground text-caption">{t.export.info_fps}</span><span className="text-foreground text-mini font-mono">30 fps</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground text-caption">{t.export.info_size}</span><span className="text-foreground text-mini font-bold">{estimatedSizeMB}</span></div>
                </div>
              </div>

              <div className="flex-1 p-5 flex flex-col gap-6 overflow-y-auto">
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <CheckboxPrimitive.Root id="v-check" checked={exportVideo} onCheckedChange={(c) => setExportVideo(!!c)} className="peer h-4 w-4 shrink-0 rounded-sm border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground transition-colors">
                      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current"><AppIcon name="Check" size={12} /></CheckboxPrimitive.Indicator>
                    </CheckboxPrimitive.Root>
                    <label htmlFor="v-check" className="text-foreground font-medium text-caption cursor-pointer select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">{t.export.video_check}</label>
                  </div>
                  {exportVideo && (
                    <div className="ml-6 flex flex-col gap-2.5">
                      <div className="flex items-center">
                        <span className="text-muted-foreground text-caption w-14 shrink-0">{t.export.video_format}</span>
                        <Select value={videoFormat} onValueChange={setVideoFormat}>
                          <SelectTrigger className="w-[160px] h-7 text-caption"><SelectValue /></SelectTrigger>
                          <SelectContent><SelectItem value="mp4">MP4</SelectItem><SelectItem value="mov">MOV</SelectItem></SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-center">
                        <span className="text-muted-foreground text-caption w-14 shrink-0">{t.export.video_ratio}</span>
                        <Select value={exportRatio} onValueChange={(v)=>setExportRatio(v as any)}>
                          <SelectTrigger className="w-[160px] h-7 text-caption"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="16:9">{t.editor?.ratio_16_9}</SelectItem>
                            <SelectItem value="9:16">{t.editor?.ratio_9_16}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-center">
                        <span className="text-muted-foreground text-caption w-14 shrink-0">{t.export.video_res}</span>
                        <Select value={videoRes} onValueChange={(v)=>setVideoRes(v as any)}>
                          <SelectTrigger className="w-[160px] h-7 text-caption"><SelectValue /></SelectTrigger>
                          <SelectContent><SelectItem value="4k">{t.export.res_4k}</SelectItem><SelectItem value="2k">{t.export.res_2k}</SelectItem><SelectItem value="1080p">{t.export.res_1080p}</SelectItem><SelectItem value="720p">{t.export.res_720p}</SelectItem></SelectContent>
                        </Select>
                      </div>
                    </div>
                  )}
                </div>

                <div className="h-[1px] bg-border w-full" />

                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <CheckboxPrimitive.Root id="j-check" checked={exportJianying} onCheckedChange={(c) => setExportJianying(!!c)} className="peer h-4 w-4 shrink-0 rounded-sm border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground transition-colors">
                      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current"><AppIcon name="Check" size={12} /></CheckboxPrimitive.Indicator>
                    </CheckboxPrimitive.Root>
                    <label htmlFor="j-check" className="text-foreground font-medium text-caption cursor-pointer select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">{t.export.jy_check}</label>
                  </div>
                  {exportJianying && (
                    <div className="ml-6 flex items-center">
                      <span className="text-muted-foreground text-caption w-14 shrink-0">{t.export.jy_platform}</span>
                      <Select value="pro" onValueChange={()=>{}}>
                        <SelectTrigger className="w-[160px] h-7 text-caption"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="pro">剪映专业版 (Win/Mac)</SelectItem></SelectContent>
                      </Select>
                    </div>
                  )}
                </div>

                <div className="h-[1px] bg-border w-full" />

                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <CheckboxPrimitive.Root id="a-check" checked={exportAudio} onCheckedChange={(c) => setExportAudio(!!c)} className="peer h-4 w-4 shrink-0 rounded-sm border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground transition-colors">
                      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current"><AppIcon name="Check" size={12} /></CheckboxPrimitive.Indicator>
                    </CheckboxPrimitive.Root>
                    <label htmlFor="a-check" className="text-foreground font-medium text-caption cursor-pointer select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">{t.export.audio_check}</label>
                  </div>
                  {exportAudio && (
                    <div className="ml-6 flex items-center">
                      <span className="text-muted-foreground text-caption w-14 shrink-0">{t.export.audio_format}</span>
                      <Select value={audioFormat} onValueChange={setAudioFormat}>
                        <SelectTrigger className="w-[160px] h-7 text-caption"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="mp3">MP3</SelectItem><SelectItem value="wav">WAV</SelectItem></SelectContent>
                      </Select>
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-2 mt-2 p-3 bg-muted/30 border border-border rounded-md">
                  <span className="text-muted-foreground text-caption font-medium">视频保存位置</span>
                  <div className="flex items-center gap-2">
                    <Input readOnly value={currentExportPath} className="flex-1 text-[11px] font-mono text-muted-foreground bg-background h-7" />
                    <Button variant="outline" className="h-7 px-3 text-[11px]" onClick={async () => {
                      const newPath = await API.system.openDirectory();
                      if (newPath) {
                        await API.system.setSetting('exportPath', newPath);
                        setCurrentExportPath(newPath);
                        AppNotifier.success('导出路径已更新');
                      }
                    }}>更改</Button>
                  </div>
                  <span className="text-[10px] text-muted-foreground">成片将保存在此目录下的【当前工程名】文件夹中。</span>
                </div>
              </div>
            </div>

            <div className="shrink-0 flex justify-end gap-3 px-4 py-3 bg-muted/30 border-t border-border">
              <Button disabled={isExporting} variant="outline" size="sm" onClick={() => setModalVisible(false)} className="h-8">
                {t.common.cancel}
              </Button>
              <Button disabled={isExporting} size="sm" onClick={executeExport} className="h-8 shadow-sm">
                {isExporting ? t.export.btn_rendering : t.export.btn_submit}
              </Button>
            </div>
            
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
};
