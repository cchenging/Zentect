// 📁 路径：src/renderer/src/utils/domEvents.ts
import React from 'react';

/**
 * 💥 全局事件防呆器：阻断一切不必要的 React 事件冒泡
 * 在节点内部的任何 Button、Input 上使用 onClick={stopEvent} 或 onClick={(e) => { stopEvent(e); doSomething(); }}
 */
export const stopEvent = (e: React.MouseEvent | React.TouchEvent | React.KeyboardEvent | React.UIEvent) => {
  e.stopPropagation();
  // 视情况可以加上 e.preventDefault()，但通常阻止冒泡即可防止 React Flow 误判
};
