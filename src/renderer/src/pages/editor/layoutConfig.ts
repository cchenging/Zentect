// 📁 路径：src/renderer/src/pages/editor/layoutConfig.ts
import type { IJsonModel } from 'flexlayout-react';

export const defaultLayoutJSON: IJsonModel = {
  global: {
    splitterSize: 4,
    theme: "dark"
  } as any,
  borders: [],
  layout: {
    type: "row",
    weight: 100,
    children: [
      {
        // 🌟 左列：纯粹的素材与 AI 指挥台
        type: "tabset",
        weight: 20,
        enableClose: false,
        children: [{ type: "tab", name: "素材与 AI 助理", component: "LeftPanel" }]
      },
      {
        // 🌟 中列：纯粹的全局语义工作流（从上到下的卡片）
        type: "tabset",
        weight: 55,
        enableClose: false,
        children: [{ type: "tab", name: "AI 剧本工作流", component: "SemanticWorkflow" }]
      },
      {
        // 🌟 右列：右上角看视频，右下角调参数
        type: "column",
        weight: 25,
        children: [
          {
            type: "tabset",
            weight: 45, // 播放器占上半
            enableClose: false,
            children: [{ type: "tab", name: "监视器", component: "MainPlayer" }]
          },
          {
            type: "tabset",
            weight: 55, // 属性占下半
            enableClose: false,
            children: [{ type: "tab", name: "属性配置", component: "RightPanel" }]
          }
        ]
      }
    ]
  }
};
