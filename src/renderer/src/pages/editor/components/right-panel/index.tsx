// 📁 路径: src/renderer/src/pages/Editor/components/RightPanel/index.tsx
import React from 'react';
import { useEditorStore } from '../../../../store/useStore';
import { useI18n } from '../../../../store/useI18n';
import { MediaParser } from './MediaParser';
import { RoleEditor } from './RoleEditor';
import { ShotEditor } from './ShotEditor';

/**
 * 格式化时长为时间码格式 (HH:MM:SS:FF)
 * @param seconds - 秒数
 * @returns 格式化后的时间码字符串
 */
const formatDuration = (seconds: number) => {
  if (isNaN(seconds) || seconds < 0) return '00:00:00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const f = Math.floor((seconds % 1) * 30);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}:${f.toString().padStart(2, '0')}`;
};

/**
 * 项目全局属性组件
 * 显示项目的基本信息，包括名称、时长、分辨率、帧率和路径
 */
const ProjectGlobalProps: React.FC = () => {
  const { projectName, projectRatio, videoDuration } = useEditorStore();
  const absolutePath = useEditorStore(s => (s as any).projectPath) || '路径解析失败'; 
  const { t } = useI18n();

  const ratioToResolution: Record<string, string> = { '16:9': '1920x1080', '9:16': '1080x1920', '4:3': '1440x1080', '1:1': '1080x1080' };
  const resolution = ratioToResolution[projectRatio] || '1920x1080';

  return (
    <div className="flex flex-col animate-in fade-in duration-200">
      <div className="flex flex-col gap-4 px-1 py-2">
        {/* 项目名称 */}
        <div className="flex justify-between items-center">
          <span className="text-body text-muted-foreground shrink-0 w-20">{t.editor?.prop_name || '名称'}</span>
          <span className="text-body text-foreground font-medium truncate text-right">{projectName}</span>
        </div>
        {/* 视频时长 */}
        <div className="flex justify-between items-center">
          <span className="text-body text-muted-foreground shrink-0 w-20">{t.editor?.prop_duration || '时长'}</span>
          <span className="text-body text-foreground font-mono tabular-nums text-right">{formatDuration(videoDuration)}</span>
        </div>
        {/* 分辨率 */}
        <div className="flex justify-between items-center">
          <span className="text-body text-muted-foreground shrink-0 w-20">{t.editor?.prop_resolution || '分辨率'}</span>
          <span className="text-body text-foreground font-mono text-right">{resolution}</span>
        </div>
        {/* 帧率 */}
        <div className="flex justify-between items-center">
          <span className="text-body text-muted-foreground shrink-0 w-20">{t.editor?.prop_fps || '帧率'}</span>
          <span className="text-body text-foreground font-mono text-right">30.00 fps</span>
        </div>
        
        {/* 分隔线 */}
        <div className="h-px bg-border my-2" />
        
        {/* 文件路径 */}
        <div className="flex justify-between items-start">
          <span className="text-body text-muted-foreground shrink-0 w-20 pt-0.5">{t.editor?.prop_location || '位置'}</span>
          <span className="text-caption text-muted-foreground break-all text-right leading-relaxed font-mono select-text pl-4">
            {absolutePath}
          </span>
        </div>
      </div>
    </div>
  );
};

/**
 * 右侧属性面板主组件
 * 根据选中的项目类型显示不同的属性编辑器
 */
export const RightPanel: React.FC = () => {
  const { selectedItemType, selectedItemId, shots, aiShots, storyboardMode } = useEditorStore();
  const activeShots = storyboardMode === 'ai' ? aiShots : shots;
  const activeShot = (selectedItemType === 'shot' || selectedItemId) ? activeShots.find(s => s.id === selectedItemId) : null;
  
  return (
    <div className="w-full h-full flex flex-col box-border overflow-x-hidden overflow-y-auto p-4">
      {(!selectedItemId && (!selectedItemType || selectedItemType === null)) && <ProjectGlobalProps />}
      {selectedItemType === 'media' && <MediaParser />}
      {selectedItemType === 'role' && <RoleEditor />}
      {activeShot && <ShotEditor shot={activeShot} />}
    </div>
  );
};
