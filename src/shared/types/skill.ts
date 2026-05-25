// 📁 新建文件: src/shared/types/skill.ts
// V1.2: 技能系统数据结构 — 骨架定义，不做 Recipe 编辑/导入导出

/** 技能定义 */
export interface Skill {
  id: string;
  name: string;                         // 如"一键解说"
  description: string;                  // 技能描述
  prompt: string;                       // 指令提示词模板
  params: Record<string, SkillParam>;   // 参数定义
  systemActions: string[];              // 可调用的系统动作列表
}

/** 技能参数定义 */
export interface SkillParam {
  key: string;
  label: string;
  type: 'slider' | 'select' | 'text';
  defaultValue: any;
  options?: { label: string; value: any }[];
}

/** 技能路由结果 — 将技能映射为可入队的批量作业 */
export interface SkillRouteResult {
  skillId: string;
  matchedActions: string[];
  pipelinePayload: {
    projectId?: string;
    mediaPath?: string;
    actionType: string;
    params?: Record<string, any>;
  };
}

/** 内建技能注册表 */
export const BUILTIN_SKILLS: Skill[] = [
  {
    id: 'quick-narrate',
    name: '一键解说',
    description: '快速对电影进行 AI 解说并生成配音',
    prompt: '请对以下电影进行专业的影视解说分析，生成解说稿。',
    params: {
      style: {
        key: 'style',
        label: '解说风格',
        type: 'select',
        defaultValue: 'professional',
        options: [
          { label: '专业影评', value: 'professional' },
          { label: '幽默吐槽', value: 'humorous' },
          { label: '悬疑解读', value: 'suspense' },
        ],
      },
      speed: {
        key: 'speed',
        label: '语音速度',
        type: 'slider',
        defaultValue: 1.0,
      },
    },
    systemActions: ['extract-media', 'generate-script', 'generate-tts', 'render-mp4'],
  },
  {
    id: 'quick-export',
    name: '一键出片',
    description: '从已有素材直接渲染 MP4 并生成发布素材包',
    prompt: '直接渲染已有视频素材。',
    params: {
      format: {
        key: 'format',
        label: '输出格式',
        type: 'select',
        defaultValue: '16:9',
        options: [
          { label: '横屏 16:9', value: '16:9' },
          { label: '竖屏 9:16', value: '9:16' },
          { label: '方形 1:1', value: '1:1' },
        ],
      },
    },
    systemActions: ['render-mp4', 'generate-publish'],
  },
];
