import React from 'react';
import { useEditorStore } from '../store/useStore';
import { Dialog, DialogContent } from './ui/dialog';
import { Settings } from '../pages/settings';

export const SettingsModal: React.FC = () => {
  const isSettingsOpen = useEditorStore((s) => s.isSettingsOpen);
  const setSettingsOpen = useEditorStore((s) => s.setSettingsOpen);

  return (
    <Dialog open={isSettingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent className="max-w-[960px] h-[680px] p-0 gap-0 overflow-hidden rounded-xl" onInteractOutside={(e) => e.preventDefault()}
        aria-label="偏好设置"
      >
        <div className="w-full h-full overflow-y-auto">
          <Settings />
        </div>
      </DialogContent>
    </Dialog>
  );
};
