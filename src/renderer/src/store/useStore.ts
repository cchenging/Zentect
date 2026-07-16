import { create } from 'zustand';
import { subscribeWithSelector, devtools } from 'zustand/middleware';
import type { EditorState } from './storeTypes';
import { createUISlice } from './slices/uiSlice';
import { createEditorSlice } from './slices/editorSlice';

export * from './storeTypes';

// 💥 统一聚合 Store：开启官方推荐的 subscribeWithSelector 和 devtools
export const useStore = create<EditorState>()(
  devtools(
    subscribeWithSelector((...a) => ({
      ...createUISlice(...a),
      ...createEditorSlice(...a),
    })),
    { name: 'Zentect-Store' }
  )
);

export const useEditorStore = useStore;
