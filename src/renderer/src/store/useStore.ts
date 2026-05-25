import { create } from 'zustand';
import { subscribeWithSelector, devtools } from 'zustand/middleware';
import type { EditorState } from './storeTypes';
import { createUISlice } from './slices/uiSlice';
import { createPlayerSlice } from './slices/playerSlice';
import { createDataSlice } from './slices/dataSlice';
import { createCanvasSlice } from './slices/canvasSlice';
import { createEditorSlice } from './slices/editorSlice';

export * from './storeTypes';

// 💥 统一聚合 Store：开启官方推荐的 subscribeWithSelector 和 devtools
export const useStore = create<EditorState>()(
  devtools(
    subscribeWithSelector((...a) => ({
      ...createUISlice(...a),
      ...createPlayerSlice(...a),
      ...createDataSlice(...a),
      ...createCanvasSlice(...a),
      ...createEditorSlice(...a),
    })),
    { name: 'Zentect-Store' }
  )
);

// 💥 导出独立的业务持久化 Store 引用（给守护进程用）
export const useEditorStore = useStore;
