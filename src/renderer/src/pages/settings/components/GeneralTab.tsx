// 📁 路径: src/renderer/src/pages/settings/components/GeneralTab.tsx
// 通用设置 Tab - V3 原型严格对齐
import React from 'react';
import { Input } from '../../../components/ui/input';
import { Button } from '../../../components/ui/button';
import { Switch } from '../../../components/ui/switch';
import { useI18n } from '../../../store/useI18n';
import { API } from '../../../api';

interface GeneralTabProps {
  data: any;
  onUpdate: (section: string, key: string, value: any) => void;
}

/**
 * 通用设置 Tab
 * V3 原型对齐：存储路径(水平布局) + 外观与语言(分段按钮) + 性能 + 危险区域
 */
export const GeneralTab: React.FC<GeneralTabProps> = ({ data, onUpdate }) => {
  const { t } = useI18n();

  /** 选择目录 */
  const handleSelectDirectory = async (field: string) => {
    const newPath = await API.system.openDirectory();
    if (newPath) onUpdate('general', field, newPath);
  };

  /** 重置所有设置 */
  const handleResetAll = async () => {
    if (window.confirm('以下操作不可逆，请谨慎操作。确定要恢复默认设置吗？')) {
      await API.settingsExt.resetAll();
      window.location.reload();
    }
  };

  return (
    <div className="space-y-6 animate-fade-in" style={{ maxWidth: '996px' }}>

      {/* ===== 存储路径 ===== */}
      <div className="glass-card-sm p-5">
        <div className="text-sm font-semibold mb-1">存储路径</div>
        <div className="text-[11px] text-muted-foreground mb-4">配置文件的默认保存位置</div>
        <div className="flex flex-col gap-4">
          {/* 项目存储位置 */}
          <div className="flex items-center gap-4">
            <div className="w-[160px] shrink-0">
              <div className="text-xs text-foreground font-medium">项目存储位置</div>
              <div className="text-[10px] text-muted-foreground">新建项目的默认存储目录</div>
            </div>
            <div className="flex-1 flex gap-2">
              <Input readOnly value={data.projectPath || ''} className="flex-1 text-xs font-mono text-muted-foreground bg-bg-secondary h-8 border-border/50" />
              <Button onClick={() => handleSelectDirectory('projectPath')} variant="outline" className="h-8 px-3 text-xs shrink-0 border-border/50 hover:border-accent/40 hover:text-accent">浏览</Button>
            </div>
          </div>
          {/* 视频导出位置 */}
          <div className="flex items-center gap-4">
            <div className="w-[160px] shrink-0">
              <div className="text-xs text-foreground font-medium">视频导出位置</div>
              <div className="text-[10px] text-muted-foreground">导出成片视频的默认目录</div>
            </div>
            <div className="flex-1 flex gap-2">
              <Input readOnly value={data.exportPath || ''} placeholder="默认 data/exports" className="flex-1 text-xs font-mono text-muted-foreground bg-bg-secondary h-8 border-border/50" />
              <Button onClick={() => handleSelectDirectory('exportPath')} variant="outline" className="h-8 px-3 text-xs shrink-0 border-border/50 hover:border-accent/40 hover:text-accent">浏览</Button>
            </div>
          </div>
          {/* 剪映草稿位置 */}
          <div className="flex items-center gap-4">
            <div className="w-[160px] shrink-0">
              <div className="text-xs text-foreground font-medium">剪映草稿位置</div>
              <div className="text-[10px] text-muted-foreground">导出剪映草稿工程的目录</div>
            </div>
            <div className="flex-1 flex gap-2">
              <Input readOnly value={data.jianyingPath || ''} placeholder={t.common?.default || '留空自动检测'} className="flex-1 text-xs font-mono text-muted-foreground bg-bg-secondary h-8 border-border/50" />
              <Button onClick={() => handleSelectDirectory('jianyingPath')} variant="outline" className="h-8 px-3 text-xs shrink-0 border-border/50 hover:border-accent/40 hover:text-accent">浏览</Button>
            </div>
          </div>
        </div>
      </div>

      {/* ===== 外观与语言 ===== */}
      <div className="glass-card-sm p-5">
        <div className="text-sm font-semibold mb-4">外观与语言</div>
        <div className="flex flex-col gap-5">
          {/* 主题选择 - 分段按钮组 */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-foreground font-medium">界面主题</div>
              <div className="text-[10px] text-muted-foreground">选择界面主题模式</div>
            </div>
            <div className="flex items-center gap-0.5 bg-bg-secondary rounded-lg p-[3px]">
              {(['dark', 'light', 'system'] as const).map(mode => (
                <button
                  key={mode}
                  onClick={() => onUpdate('general', 'mode', mode)}
                  className={`px-3 py-1.5 rounded-md text-[11px] font-medium transition-all cursor-pointer outline-none ${
                    (data.mode || 'dark') === mode
                      ? 'bg-gradient-to-r from-accent to-accent-purple text-white shadow-sm shadow-accent/20'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {mode === 'dark' ? '深色' : mode === 'light' ? '浅色' : '跟随系统'}
                </button>
              ))}
            </div>
          </div>
          {/* 语言选择 */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-foreground font-medium">界面语言</div>
              <div className="text-[10px] text-muted-foreground">重启应用后生效</div>
            </div>
            <div className="flex items-center gap-0.5 bg-bg-secondary rounded-lg p-[3px]">
              {(['zh-CN', 'en'] as const).map(lang => (
                <button
                  key={lang}
                  onClick={() => onUpdate('general', 'language', lang)}
                  className={`px-3 py-1.5 rounded-md text-[11px] font-medium transition-all cursor-pointer outline-none ${
                    (data.language || 'zh-CN') === lang
                      ? 'bg-accent/15 text-accent'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {lang === 'zh-CN' ? '简体中文' : 'English'}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ===== 性能 ===== */}
      <div className="glass-card-sm p-5">
        <div className="text-sm font-semibold mb-4">性能</div>
        <div className="flex flex-col gap-5">
          {/* GPU 硬件加速 */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-foreground font-medium">GPU 硬件加速</div>
              <div className="text-[10px] text-muted-foreground">启用 GPU 加速视频编解码</div>
            </div>
            <Switch
              checked={data.gpuAcceleration !== false}
              onCheckedChange={(v) => onUpdate('general', 'gpuAcceleration', v)}
            />
          </div>
          {/* 自动保存间隔 */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-foreground font-medium">自动保存间隔</div>
              <div className="text-[10px] text-muted-foreground">编辑器草稿自动保存频率</div>
            </div>
            <div className="flex items-center gap-0.5 bg-bg-secondary rounded-lg p-[3px]">
              {[3, 5, 10, 30].map(sec => (
                <button
                  key={sec}
                  onClick={() => onUpdate('general', 'autoSaveInterval', sec)}
                  className={`px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-all cursor-pointer outline-none ${
                    (data.autoSaveInterval || 5) === sec
                      ? 'bg-accent/15 text-accent'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {sec}秒
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ===== 危险区域 ===== */}
      <div className="rounded-xl p-5 border border-accent-rose/25 bg-accent-rose/5">
        <div className="text-sm font-semibold text-accent-rose mb-1">危险区域</div>
        <div className="text-[11px] text-muted-foreground mb-4">以下操作不可逆，请谨慎操作</div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-foreground font-medium">恢复默认设置</div>
          </div>
          <button
            onClick={handleResetAll}
            className="h-8 px-4 rounded-lg bg-accent-rose/15 border border-accent-rose/30 text-[11px] font-semibold text-accent-rose hover:bg-accent-rose/25 transition-all cursor-pointer outline-none"
          >
            恢复默认设置
          </button>
        </div>
      </div>
    </div>
  );
};
