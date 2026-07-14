import React, { useState, useMemo } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useProjectStore } from '../../../../editor/stores/useProjectStore';
import { useStep3Store } from '../../../../pipeline/stores/useStep3Store';
import { getSafeMediaUrl } from '../../../../../renderer/src/utils/formatUrl';
import { formatDurationStandard } from '../../../../../renderer/src/utils/timeUtils';
import { AppNotifier } from '../../../../../renderer/src/core/AppNotifier';
import { Button } from '../../../../../renderer/src/components/ui/button';
import { Input } from '../../../../../renderer/src/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../../../renderer/src/components/ui/select';
import { useI18n } from '../../../../../renderer/src/store/useI18n';
import { API } from '../../../../../renderer/src/api';
import { AppIcon } from '../../../../../renderer/src/components/app-icon';
import { ExportCheckbox } from './ExportCheckbox';

export const ExportModal: React.FC = () => {
  const { t } = useI18n();

  const [open, setOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [currentExportPath, setCurrentExportPath] = useState('');

  const [exportVideo, setExportVideo] = useState(true);
  const [exportJianying, setExportJianying] = useState(false);
  const [exportAudio, setExportAudio] = useState(false);
  const [exportSubtitle, setExportSubtitle] = useState(false);
  const [exportTxt, setExportTxt] = useState(false);
  const [subtitleFormat, setSubtitleFormat] = useState<'srt' | 'ass'>('srt');
  const [exportProgress, setExportProgress] = useState(0);

  const [videoFormat, setVideoFormat] = useState('mp4');
  const [exportRatio, setExportRatio] = useState<'16:9' | '9:16'>('16:9');
  const [videoRes, setVideoRes] = useState<'4k' | '2k' | '1080p' | '720p'>('1080p');
  const [audioFormat, setAudioFormat] = useState('mp3');

  const { coverUrl, currentDuration, exactResolutionStr, estimatedSizeMB } = useMemo(() => {
    if (!open) return { coverUrl: '', currentDuration: 0, exactResolutionStr: '1920x1080', estimatedSizeMB: '0.0 MB' };

    const state = useProjectStore.getState();
    const activeShots = state.storyboardMode === 'ai' ? state.aiShots : state.shots;
    const mediaArray = Array.isArray(state.mediaItems) ? state.mediaItems : [];
    let url = '';
    if (activeShots.length > 0 && mediaArray.length > 0) {
      const firstMedia = mediaArray.find((m) => m.id === activeShots[0].mediaId) || mediaArray[0];
      if (firstMedia) url = getSafeMediaUrl(firstMedia.filePath);
    }
    const dur = activeShots.length > 0 ? activeShots[activeShots.length - 1].end : 0;
    const resMap = {
      '4k': { w: 3840, h: 2160 },
      '2k': { w: 2560, h: 1440 },
      '1080p': { w: 1920, h: 1080 },
      '720p': { w: 1280, h: 720 }
    };
    const baseRes = resMap[videoRes];
    const width = exportRatio === '9:16' ? baseRes.h : baseRes.w;
    const height = exportRatio === '9:16' ? baseRes.w : baseRes.h;
    const videoBitrate = { '4k': 35000, '2k': 16000, '1080p': 8000, '720p': 5000 }[videoRes] || 8000;
    const sizeMB = ((videoBitrate + 192) * dur) / 8192 * 1.02;
    return {
      coverUrl: url,
      currentDuration: dur,
      exactResolutionStr: `${width}x${height}`,
      estimatedSizeMB: sizeMB > 0 ? sizeMB.toFixed(1) + ' MB' : '0.0 MB'
    };
  }, [open, videoRes, exportRatio]);

  const handleOpen = async () => {
    const state = useProjectStore.getState();
    const activeShots = state.storyboardMode === 'ai' ? state.aiShots : state.shots;
    if (!activeShots || activeShots.length === 0) {
      AppNotifier.warn('BIZ_TRACK_EMPTY');
      return;
    }
    const paths = await API.system.getPaths();
    setCurrentExportPath(paths.exports);
    setOpen(true);
  };

  /** 将秒数格式化为 SRT 时间格式 (HH:MM:SS,mmm) */
  const formatSrtTime = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };

  /** 将秒数格式化为 ASS 时间格式 (H:MM:SS.cc) */
  const formatAssTime = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const cs = Math.round((seconds % 1) * 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  };

  /** 根据 shots 数据生成 SRT 格式字幕内容 */
  const generateSRT = (shots: any[]): string => {
    return shots
      .filter((shot) => shot.text || shot.aiText || shot.ttsText)
      .map((shot, idx) => {
        const text = shot.aiText || shot.ttsText || shot.text || '';
        const start = shot.start ?? 0;
        const end = shot.end ?? (start + (shot.duration ?? 3));
        return `${idx + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${text}\n`;
      })
      .join('\n');
  };

  /** 根据 shots 数据生成 ASS 格式字幕内容 */
  const generateASS = (shots: any[], projectName: string): string => {
    const header = `[Script Info]
Title: ${projectName}
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Microsoft YaHei,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,10,10,30,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
    const dialogues = shots
      .filter((shot) => shot.text || shot.aiText || shot.ttsText)
      .map((shot) => {
        const text = (shot.aiText || shot.ttsText || shot.text || '').replace(/\n/g, '\\N');
        const start = shot.start ?? 0;
        const end = shot.end ?? (start + (shot.duration ?? 3));
        return `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,,0,0,0,,${text}`;
      })
      .join('\n');
    return header + dialogues;
  };

  /** 根据 scriptParagraphs 数据生成文案 TXT 内容 */
  const generateTXT = (paragraphs: any[]): string => {
    return paragraphs
      .map((p) => p.text || p.content || p.narration || '')
      .filter((text) => text.trim())
      .join('\n\n');
  };

  const executeExport = async () => {
    if (!exportVideo && !exportJianying && !exportAudio && !exportSubtitle && !exportTxt) {
      AppNotifier.warn('请勾选输出管线');
      return;
    }
    setIsExporting(true);
    setExportProgress(0);
    try {
      const state = useProjectStore.getState();
      const isAiExport = state.storyboardMode === 'ai';
      const targetShots = isAiExport ? state.aiShots : state.shots;
      if (isAiExport && targetShots.find((s) => s.aiText && !s.audioPath))
        throw new Error('存在未配音台词，拒绝渲染。');
      const [exactWidth, exactHeight] = exactResolutionStr.split('x').map(Number);
      const payload = {
        projectId: state.projectId || '',
        projectName: state.projectName || '',
        ratio: exportRatio,
        resolution: videoRes,
        exactWidth,
        exactHeight,
        shots: JSON.parse(JSON.stringify(targetShots)),
        mediaItems: JSON.parse(JSON.stringify(state.mediaItems)),
        isAiMode: isAiExport,
        activeShots: JSON.parse(JSON.stringify(targetShots)),
        subtitleFormat,
        audioFormat,
      };

      const tasks: Promise<any>[] = [];
      if (exportJianying) tasks.push(API.export.jianying(payload));
      if (exportVideo) tasks.push(API.export.localVideo({ ...payload, format: videoFormat }));
      /** 音频导出：复用 localVideo 通道，传入 audioOnly 标记和音频格式 */
      if (exportAudio) tasks.push(API.export.localVideo({ ...payload, format: audioFormat, audioOnly: true }));
      /** 字幕导出：前端生成字幕内容，通过 IPC 写入文件 */
      if (exportSubtitle) {
        const subtitleContent = subtitleFormat === 'ass'
          ? generateASS(targetShots, state.projectName || 'untitled')
          : generateSRT(targetShots);
        tasks.push(API.export.subtitle({
          ...payload,
          content: subtitleContent,
          format: subtitleFormat,
          exportPath: currentExportPath,
        }));
      }
      /** 文案 TXT 导出：前端生成文本内容，通过 IPC 写入文件 */
      if (exportTxt) {
        const txtContent = generateTXT(useStep3Store.getState().scriptParagraphs || []);
        tasks.push(API.export.txt({
          ...payload,
          content: txtContent,
          exportPath: currentExportPath,
        }));
      }

      /** 模拟导出进度 */
      const progressInterval = setInterval(() => {
        setExportProgress(prev => Math.min(prev + Math.random() * 15, 90));
      }, 500);
      let intervalCleared = false;

      try {
        await Promise.all(tasks);
        clearInterval(progressInterval);
        intervalCleared = true;
        setExportProgress(100);
        AppNotifier.success('TASK_EXPORT_SUCCESS');
        setOpen(false);
      } finally {
        if (!intervalCleared) clearInterval(progressInterval);
      }
    } catch (e: any) {
      AppNotifier.error(e.message);
    } finally {
      setIsExporting(false);
      setExportProgress(0);
    }
  };

  const dialogOpenChange = (next: boolean) => {
    if (!isExporting) setOpen(next);
  };

  const projectName = useProjectStore((s) => s.projectName) || '';
  const storyboardMode = useProjectStore((s) => s.storyboardMode);

  return (
    <>
      <Button size="sm" onClick={handleOpen} className="h-7 px-3 font-semibold shadow-sm text-[11px] rounded">
        {t.export.topbar_export}
      </Button>

      <DialogPrimitive.Root open={open} onOpenChange={dialogOpenChange}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <DialogPrimitive.Content className="fixed left-[50%] top-[50%] z-[100] w-[580px] translate-x-[-50%] translate-y-[-50%] bg-background border border-border rounded-lg shadow-xl flex flex-col overflow-hidden outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-200">
            <div className="px-4 py-3 border-b border-border flex justify-between items-center bg-muted/30 shrink-0">
              <DialogPrimitive.Title className="m-0 text-body font-semibold text-foreground tracking-wide">
                {t.export.title}
              </DialogPrimitive.Title>
              <div className="flex items-center gap-3">
                <span className="text-muted-foreground text-caption">
                  {storyboardMode === 'ai' ? t.editor?.engine_ai : t.editor?.engine_phy}
                </span>
                <DialogPrimitive.Close asChild>
                  <button className="bg-transparent border-none text-muted-foreground hover:text-foreground cursor-pointer outline-none p-1 rounded-sm hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring">
                    <AppIcon name="X" size={16} />
                  </button>
                </DialogPrimitive.Close>
              </div>
            </div>

            <div className="flex flex-row h-[340px] bg-background">
              <div className="w-[220px] border-r border-border p-4 overflow-y-auto shrink-0 flex flex-col bg-muted/10">
                <div className="w-full aspect-video bg-black/50 rounded border border-border mb-4 overflow-hidden flex items-center justify-center shrink-0 shadow-inner">
                  {coverUrl ? (
                    <img src={coverUrl} alt="Cover" className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-muted-foreground text-caption">{t.editor?.signal_lost}</span>
                  )}
                </div>
                <h6 className="text-foreground m-0 mb-4 text-body break-all font-medium">{projectName}</h6>
                <div className="flex flex-col gap-3">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground text-caption">{t.export.info_duration}</span>
                    <span className="text-foreground text-mini font-mono">
                      {formatDurationStandard(currentDuration)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground text-caption">{t.export.info_ratio}</span>
                    <span className="text-foreground text-mini">{exportRatio}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground text-caption">{t.export.info_resolution}</span>
                    <span className="text-foreground text-mini">{exactResolutionStr}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground text-caption">{t.export.info_fps}</span>
                    <span className="text-foreground text-mini font-mono">30 fps</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground text-caption">{t.export.info_size}</span>
                    <span className="text-foreground text-mini font-bold">{estimatedSizeMB}</span>
                  </div>
                </div>
              </div>

              <div className="flex-1 p-5 flex flex-col gap-6 overflow-y-auto">
                <ExportCheckbox
                  id="v-check"
                  checked={exportVideo}
                  onCheckedChange={setExportVideo}
                  label={t.export.video_check}
                >
                  <div className="flex items-center">
                    <span className="text-muted-foreground text-caption w-14 shrink-0">{t.export.video_format}</span>
                    <Select value={videoFormat} onValueChange={setVideoFormat}>
                      <SelectTrigger className="w-[160px] h-7 text-caption"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="mp4">MP4</SelectItem><SelectItem value="mov">MOV</SelectItem></SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center">
                    <span className="text-muted-foreground text-caption w-14 shrink-0">{t.export.video_ratio}</span>
                    <Select value={exportRatio} onValueChange={(v) => setExportRatio(v as any)}>
                      <SelectTrigger className="w-[160px] h-7 text-caption"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="16:9">{t.editor?.ratio_16_9}</SelectItem>
                        <SelectItem value="9:16">{t.editor?.ratio_9_16}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center">
                    <span className="text-muted-foreground text-caption w-14 shrink-0">{t.export.video_res}</span>
                    <Select value={videoRes} onValueChange={(v) => setVideoRes(v as any)}>
                      <SelectTrigger className="w-[160px] h-7 text-caption"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="4k">{t.export.res_4k}</SelectItem>
                        <SelectItem value="2k">{t.export.res_2k}</SelectItem>
                        <SelectItem value="1080p">{t.export.res_1080p}</SelectItem>
                        <SelectItem value="720p">{t.export.res_720p}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </ExportCheckbox>

                <div className="h-[1px] bg-border w-full" />

                <ExportCheckbox
                  id="j-check"
                  checked={exportJianying}
                  onCheckedChange={setExportJianying}
                  label={t.export.jy_check}
                >
                  <div className="flex items-center">
                    <span className="text-muted-foreground text-caption w-14 shrink-0">{t.export.jy_platform}</span>
                    <Select value="pro" onValueChange={() => {}}>
                      <SelectTrigger className="w-[160px] h-7 text-caption"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="pro">剪映专业版 (Win/Mac)</SelectItem></SelectContent>
                    </Select>
                  </div>
                </ExportCheckbox>

                <div className="h-[1px] bg-border w-full" />

                <ExportCheckbox
                  id="a-check"
                  checked={exportAudio}
                  onCheckedChange={setExportAudio}
                  label={t.export.audio_check}
                >
                  <div className="flex items-center">
                    <span className="text-muted-foreground text-caption w-14 shrink-0">{t.export.audio_format}</span>
                    <Select value={audioFormat} onValueChange={setAudioFormat}>
                      <SelectTrigger className="w-[160px] h-7 text-caption"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="mp3">MP3</SelectItem><SelectItem value="wav">WAV</SelectItem></SelectContent>
                    </Select>
                  </div>
                </ExportCheckbox>

                <div className="h-[1px] bg-border w-full" />

                {/* SRT 字幕导出 */}
                <ExportCheckbox
                  id="s-check"
                  checked={exportSubtitle}
                  onCheckedChange={setExportSubtitle}
                  label="字幕文件"
                >
                  <div className="flex items-center">
                    <span className="text-muted-foreground text-caption w-14 shrink-0">格式</span>
                    <Select value={subtitleFormat} onValueChange={(v) => setSubtitleFormat(v as any)}>
                      <SelectTrigger className="w-[160px] h-7 text-caption"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="srt">SRT</SelectItem><SelectItem value="ass">ASS</SelectItem></SelectContent>
                    </Select>
                  </div>
                </ExportCheckbox>

                <div className="h-[1px] bg-border w-full" />

                {/* TXT 文案导出 */}
                <ExportCheckbox
                  id="t-check"
                  checked={exportTxt}
                  onCheckedChange={setExportTxt}
                  label="解说文案 (TXT)"
                />

                <div className="flex flex-col gap-2 mt-2 p-3 bg-muted/30 border border-border rounded-md">
                  <span className="text-muted-foreground text-caption font-medium">视频保存位置</span>
                  <div className="flex items-center gap-2">
                    <Input
                      readOnly
                      value={currentExportPath}
                      className="flex-1 text-[11px] font-mono text-muted-foreground bg-background h-7"
                    />
                    <Button
                      variant="outline"
                      className="h-7 px-3 text-[11px]"
                      onClick={async () => {
                        const newPath = await API.system.openDirectory();
                        if (newPath) {
                          await API.system.setSetting('exportPath', newPath);
                          setCurrentExportPath(newPath);
                          AppNotifier.success('导出路径已更新');
                        }
                      }}
                    >
                      更改
                    </Button>
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    成片将保存在此目录下的【当前工程名】文件夹中。
                  </span>
                </div>
              </div>
            </div>

            <div className="shrink-0 flex flex-col gap-2 px-4 py-3 bg-muted/30 border-t border-border">
              {/* 导出进度条 */}
              {isExporting && (
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-accent rounded-full transition-all duration-300" style={{ width: `${exportProgress}%` }} />
                  </div>
                  <span className="text-[11px] text-accent font-medium">{Math.round(exportProgress)}%</span>
                </div>
              )}
              <div className="flex justify-end gap-3">

              <Button
                disabled={isExporting}
                variant="outline"
                size="sm"
                onClick={() => setOpen(false)}
                className="h-8"
              >
                {t.common.cancel}
              </Button>
              <Button disabled={isExporting} size="sm" onClick={executeExport} className="h-8 shadow-sm">
                {isExporting ? t.export.btn_rendering : t.export.btn_submit}
              </Button>
              </div>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
};
