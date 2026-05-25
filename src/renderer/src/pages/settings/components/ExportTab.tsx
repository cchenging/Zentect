import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select';
import { useI18n } from '../../../store/useI18n';

interface ExportTabProps {
  data: any;
  onUpdate: (section: string, key: string, value: any) => void;
}

/**
 * 导出配置 Tab
 * 视频渲染加速引擎选择
 */
export const ExportTab: React.FC<ExportTabProps> = ({ data, onUpdate }) => {
  const { t } = useI18n();

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div>
        <h3 className="text-lg font-medium text-zinc-100">{t.settings?.editing_title || '剪辑引擎配置'}</h3>
        <p className="text-sm text-zinc-500 mt-1">配置视频渲染和导出参数。</p>
      </div>
      <div className="flex flex-col gap-6 bg-card border border-border rounded-lg p-6 shadow-sm">
        <div className="flex flex-col gap-2 w-full">
           <span className="text-caption text-foreground font-medium">{t.settings?.render_engine_label || '视频渲染加速引擎'}</span>
           <Select
             value={data.enableGpuAcceleration ? 'gpu' : 'cpu'}
             onValueChange={(v) => onUpdate('export', 'enableGpuAcceleration', v === 'gpu')}
           >
             <SelectTrigger className="h-8 text-caption bg-background">
               <SelectValue />
             </SelectTrigger>
             <SelectContent>
               <SelectItem value="cpu" className="text-caption">{t.settings?.render_cpu || '仅使用 CPU 软解 (兼容性极高)'}</SelectItem>
               <SelectItem value="gpu" className="text-caption">{t.settings?.render_gpu || '强制开启 GPU 硬件加速 (Nvenc/QSV)'}</SelectItem>
             </SelectContent>
           </Select>
           <span className="text-mini text-muted-foreground mt-2 leading-relaxed bg-muted/50 p-2 rounded border border-border">
             {t.settings?.render_desc || '开启 GPU 加速可以极大提升底层 FFmpeg 的导出速度，但如果您没有独立显卡或驱动版本过旧，可能会导致渲染失败。'}
           </span>
        </div>
      </div>
    </div>
  );
};
