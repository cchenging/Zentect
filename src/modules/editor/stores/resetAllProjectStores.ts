// 📁 路径: src/modules/editor/stores/resetAllProjectStores.ts
// 🛑 原则 3: 项目状态实例化 — 切换项目时彻底重置所有 store
//
// 设计:每个 store 自带 reset() 方法,初始值定义在 store 内部(单一数据源)。
//      本函数只负责调用各 store.reset(),不手动 setState,避免初始值散落两处。
//
// 数据流:reset(清空到初始值) → hydrateProjectData(从 DB 读取真相覆盖)
//         DB 是唯一真相源,reset 只是清空内存瞬态,防止旧项目数据泄漏到新项目。

import { useProjectStore } from './useProjectStore';
import { useStep1Store } from '../../pipeline/stores/useStep1Store';
import { useStep2Store } from '../../pipeline/stores/useStep2Store';
import { useStep3Store } from '../../pipeline/stores/useStep3Store';
import { useStep4Store } from '../../pipeline/stores/useStep4Store';
import { useStep5Store } from '../../pipeline/stores/useStep5Store';
import { usePipelineStore } from '@renderer/store/usePipelineStore';
import { useEditorNavStore } from './useEditorNavStore';
import { usePlayerStore } from './usePlayerStore';

/**
 * 彻底重置所有项目相关 store 到初始状态
 * 在项目切换(useEditorLogic 进场)时调用
 * 重置后由 hydrateProjectData 从 DB 无条件恢复(DB 是真相源)
 */
export function resetAllProjectStores(): void {
  // 各 store 自带 reset(),初始值由 store 内部定义,不会遗漏字段
  useProjectStore.getState().resetProjectState();
  useStep1Store.getState().reset();
  useStep2Store.getState().reset();
  useStep3Store.getState().reset();
  useStep4Store.getState().reset();
  useStep5Store.getState().reset();
  usePipelineStore.getState().reset();
  useEditorNavStore.getState().reset();
  usePlayerStore.getState().resetState();
}
