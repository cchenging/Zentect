// 📁 路径：src/renderer/src/pages/editor/config/templates.ts

/** 工作流模板列表（画布节点系统已移除，保留最少骨架防止引用报错） */
export const TEMPLATES = [
  {
    id: 'tpl-blank',
    name: '未命名工作流',
    description: '标准桌面级空白画布模板',
    nodes: [] as any[],
    edges: [] as any[]
  }
];

export const DEFAULT_WORKFLOW = TEMPLATES[0];
