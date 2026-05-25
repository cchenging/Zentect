// 📁 路径：src/renderer/src/pages/home/components/RenameModal.tsx
import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '../../../components/ui/dialog';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { useI18n } from '../../../store/useI18n';
import type { ProjectRecord } from '../types';
import { FrontendLogger } from '../../../utils/logger';
import { Validator } from '../../../../../shared/utils/Validator'; // 💥 引入本地前置校验

interface RenameModalProps {
  visible: boolean;
  project: ProjectRecord | null;
  onClose: () => void;
  // 💥 改为支持 async，以便捕获后端重名报错
  onConfirm: (id: string, newName: string) => Promise<void> | void; 
}

export const RenameModal: React.FC<RenameModalProps> = ({ visible, project, onClose, onConfirm }) => {
  const [name, setName] = useState('');
  const [errorMsg, setErrorMsg] = useState(''); // 💥 新增：红字错误状态
  const { t } = useI18n();

  useEffect(() => {
    if (visible && project) {
      setName(project.name);
      setErrorMsg(''); // 弹窗开启时清空历史错误
    }
  }, [visible, project]);

  const handleConfirm = async () => {
    setErrorMsg('');
    const trimmedName = name.trim();
    if (!trimmedName || !project) return;
    
    // 1. 本地防呆拦截：调用 Validator
    const validation = Validator.validateProjectName(trimmedName);
    if (!validation.valid) {
       setErrorMsg((t.errors as Record<string, string>)?.[validation.errorKey!] || '项目名称不符合规范');
       return;
    }

    const traceId = FrontendLogger.generateTraceId();
    FrontendLogger.info('Home_RenameModal', 'User confirmed rename operation', traceId, { projectId: project.id, newName: trimmedName });
    
    try {
      // 2. 尝试下发后端
      await onConfirm(project.id, trimmedName);
      onClose(); // 只有成功才关闭弹窗
    } catch (e: any) {
      FrontendLogger.error('Home_RenameModal', 'Rename operation failed', traceId, e.message);
      // 3. 💥 精准捕获后端抛出的重名错误并翻译！
       setErrorMsg((t.errors as Record<string, string>)?.[e.message] || e.message || '重命名失败，发生未知错误');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleConfirm();
  };

  return (
    <Dialog open={visible} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[420px] p-6 gap-6">
        
        <DialogHeader className="gap-1.5">
          <DialogTitle className="text-title font-bold tracking-tight text-foreground">
            {t.home?.rename_title || '重命名项目'}
          </DialogTitle>
          <DialogDescription className="text-caption text-muted-foreground">
            请输入新的项目名称，支持中英文、数字及下划线。
          </DialogDescription>
        </DialogHeader>
        
        <div className="flex flex-col gap-2">
          <Input 
            value={name} 
            onChange={e => {
              setName(e.target.value);
              if (errorMsg) setErrorMsg(''); // 用户修改时清除报错
            }} 
            onKeyDown={handleKeyDown}
            placeholder={t.home?.rename_placeholder || '请输入新名称'}
            className={`h-10 text-body bg-muted/50 focus-visible:ring-primary ${errorMsg ? 'border-destructive focus-visible:ring-destructive' : 'border-border'}`}
            autoFocus
          />
          {/* 💥 优雅的就地错误提示 */}
          {errorMsg && <span className="text-[11px] text-destructive px-1">{errorMsg}</span>}
        </div>

        <DialogFooter className="gap-3 sm:justify-end mt-2">
          <Button variant="outline" onClick={onClose} className="h-9 px-5 text-body">
            {t.common?.cancel || '取消'}
          </Button>
          <Button 
            onClick={handleConfirm} 
            disabled={!name.trim() || name.trim() === project?.name} 
            className="h-9 px-5 text-body font-medium shadow-sm transition-all"
          >
            {t.common?.confirm || '确认修改'}
          </Button>
        </DialogFooter>

      </DialogContent>
    </Dialog>
  );
};
