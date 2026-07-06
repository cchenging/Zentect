/**
 * @deprecated 已迁移至 src/modules/editor/shell/frontend/hooks/useKeyboardShortcuts.ts
 * 请使用 import { useKeyboardShortcuts } from '@/modules/editor/shell'
 */

import { useEffect } from 'react';
import { useEditorStore } from '../../../store/useStore';
import { DraftService } from '../../../services/DraftService';

export const useKeyboardShortcuts = () => {
  const nodes = useEditorStore(s => s.nodes);
  const edges = useEditorStore(s => s.edges);
  const projectId = useEditorStore(s => s.projectId);
  const setInspectorOpen = useEditorStore(s => s.setInspectorOpen);
  const setActiveNode = useEditorStore(s => s.setActiveNode);
  const undo = useEditorStore(s => s.undo);
  const redo = useEditorStore(s => s.redo);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isCtrlOrCmd = e.ctrlKey || e.metaKey;

      // Ctrl+S: 保存
      if (isCtrlOrCmd && e.key === 's') {
        e.preventDefault();
        if (projectId) {
          const snapshot = JSON.stringify({ nodes, edges });
          DraftService.saveDraft(projectId, snapshot).catch(() => {});
        }
        return;
      }

      // Ctrl+Z: 撤销
      if (isCtrlOrCmd && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }

      // Ctrl+Shift+Z: 重做
      if (isCtrlOrCmd && e.key === 'z' && e.shiftKey) {
        e.preventDefault();
        redo();
        return;
      }

      // Escape: 关闭面板
      if (e.key === 'Escape') {
        setInspectorOpen(false);
        setActiveNode(null, null);
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [nodes, edges, projectId, setInspectorOpen, setActiveNode, undo, redo]);
};
