// 📁 路径：src/renderer/src/pages/Home/components/DeleteModal.tsx
import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '../../../components/ui/dialog';
import { Button } from '../../../components/ui/button';
import { AppIcon } from '../../../components/app-icon';
import { useI18n } from '../../../store/useI18n';
import { FrontendLogger } from '../../../utils/logger';

interface DeleteModalProps {
  visible: boolean;
  projectId: string | null;
  projectName: string;
  onClose: () => void;
  onConfirm: (id: string) => void;
}

export const DeleteModal: React.FC<DeleteModalProps> = ({ visible, projectId, projectName, onClose, onConfirm }) => {
  const { t } = useI18n();

  const handleConfirm = () => {
    if (!projectId) return;
    const traceId = FrontendLogger.generateTraceId();
    FrontendLogger.warn('Home_DeleteModal', 'User confirmed project deletion', traceId, { projectId, projectName });
    
    try {
      onConfirm(projectId);
    } catch (e: any) {
      FrontendLogger.error('Home_DeleteModal', 'Project deletion failed', traceId, e.message);
    }
  };

  return (
    <Dialog open={visible} onOpenChange={(open) => !open && onClose()}>
      {/* 💥 规范化：p-6, gap-6，并且给外层加一点红色的 border 晕染 */}
      <DialogContent className="sm:max-w-[420px] p-6 gap-6 border-destructive/20 shadow-[0_10px_40px_-10px_color-mix(in_srgb,var(--destructive)_10%,transparent)]">
        
        <DialogHeader className="gap-2">
          <div className="flex items-center gap-2.5 text-destructive">
             <div className="w-8 h-8 rounded-full bg-destructive/10 flex items-center justify-center">
               <AppIcon name="AlertTriangle" size={16} className="text-destructive" />
             </div>
             <DialogTitle className="text-title font-bold tracking-tight text-foreground">
               {t.home?.delete_title || '确认永久删除项目？'}
             </DialogTitle>
          </div>
          <DialogDescription className="text-caption text-muted-foreground leading-relaxed pl-[42px]">
            {t.home?.delete_confirm_desc || '此操作无法撤销。该工程及其本地相关的缓存媒体数据将被彻底抹除。'}
          </DialogDescription>
        </DialogHeader>
        
        {/* 💥 规范化：信息展示区块，采用严谨的 p-3 内边距和 text-body 字体 */}
        <div className="ml-[42px] p-3 bg-muted/50 border border-border rounded-md flex items-center gap-2">
          <AppIcon name="Folder" size={14} className="text-muted-foreground shrink-0" />
          <span className="text-body font-medium text-foreground truncate" title={projectName}>
            {projectName}
          </span>
        </div>

        <DialogFooter className="gap-3 sm:justify-end mt-2">
          <Button variant="outline" onClick={onClose} className="h-9 px-5 text-body">
            {t.common?.cancel || '取消'}
          </Button>
          <Button variant="destructive" onClick={handleConfirm} className="h-9 px-5 text-body font-medium shadow-sm gap-2">
            <AppIcon name="Trash2" size={14} /> {t.common?.confirm_delete || '确认删除'}
          </Button>
        </DialogFooter>

      </DialogContent>
    </Dialog>
  );
};
