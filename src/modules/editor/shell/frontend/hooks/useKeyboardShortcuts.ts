// Module: editor/shell/hooks/useKeyboardShortcuts
// 原 editor/hooks/useKeyboardShortcuts.ts — 已迁移

import { useEffect } from 'react';
import { useEditorStore } from '@renderer/store/useStore';
import { useProjectStore } from '@modules/editor/stores/useProjectStore';
import { DraftService } from '@renderer/services/DraftService';

export const useKeyboardShortcuts = () => {
  const nodes = useEditorStore(s => s.nodes);
  const edges = useEditorStore(s => s.edges);
  const projectId = useProjectStore(s => s.projectId);
  const setInspectorOpen = useEditorStore(s => s.setInspectorOpen);
  const setActiveNode = useEditorStore(s => s.setActiveNode);
  const undo = useProjectStore(s => s.undo);
  const redo = useProjectStore(s => s.redo);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isCtrlOrCmd = e.ctrlKey || e.metaKey;

      if (isCtrlOrCmd && e.key === 's') {
        e.preventDefault();
        if (projectId) {
          const snapshot = JSON.stringify({ nodes, edges });
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
        setInspectorOpen(false);
        setActiveNode(null, null);
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [nodes, edges, projectId, setInspectorOpen, setActiveNode, undo, redo]);
};
