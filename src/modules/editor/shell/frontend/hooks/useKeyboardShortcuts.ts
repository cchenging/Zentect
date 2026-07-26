// Module: editor/shell/hooks/useKeyboardShortcuts
// 原 editor/hooks/useKeyboardShortcuts.ts — 已迁移

import { useEffect } from 'react';
import { useProjectStore } from '@modules/editor/stores/useProjectStore';
import { DraftService } from '@renderer/services/DraftService';

export const useKeyboardShortcuts = () => {
  // 🔧 修复 TS2339：nodes/edges/setActiveNode 已从 EditorSlice 迁移/移除，本 hook 仅保留 Ctrl+S 草稿保存
  const projectId = useProjectStore(s => s.projectId);
  const undo = useProjectStore(s => s.undo);
  const redo = useProjectStore(s => s.redo);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isCtrlOrCmd = e.ctrlKey || e.metaKey;

      if (isCtrlOrCmd && e.key === 's') {
        e.preventDefault();
        if (projectId) {
          // 草稿快照仅保留 projectId（nodes/edges 已迁移，不再持久化画布状态）
          const snapshot = JSON.stringify({ projectId, savedAt: new Date().toISOString() });
          DraftService.saveDraft(projectId, snapshot).catch(() => {});
        }
        return;
      }

      if (isCtrlOrCmd && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }

      if (isCtrlOrCmd && e.key === 'z' && e.shiftKey) {
        e.preventDefault();
        redo();
        return;
      }

      if (e.key === 'Escape') {
        // 🔧 修复 TS2339：setInspectorOpen/setActiveNode 已移除，Escape 不再处理画布选中清空
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [projectId, undo, redo]);
};
