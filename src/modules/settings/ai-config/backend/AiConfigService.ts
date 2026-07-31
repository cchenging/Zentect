// 📁 路径：src/modules/settings/ai-config/backend/AiConfigService.ts
// AI 配置服务：封装 API Profile CRUD + 连接测试（§3.7.1）
// ⚠️ 注意：此文件不 re-export ApiProfileRepository，renderer 通过 IPC 访问数据库

/**
 * 预设供应商配置（2026-07 联网核实官方文档）
 * - 火山方舟：model id 必须带版本号后缀，不能用营销名
 * - DeepSeek：deepseek-chat/deepseek-reasoner 已于 2026-07-24 下架，现仅 v4 系列
 * - 通义千问：百炼平台兼容模式，model id 用点号分隔
 * - 腾讯混元：OpenAI 兼容接口
 */
export const PROVIDER_CONFIGS: Record<string, {
  id: string; name: string; fullName: string;
  baseUrl: string; models: string[]; keyUrl: string;
}> = {
  doubao: {
    id: 'doubao', name: '火山方舟', fullName: '火山方舟 (ByteDance)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    // 🔧 修复：替换虚构模型 ID 为官方文档真实 model id
    models: [
      'doubao-seed-1-6-251015',         // 深度思考主力（多模态）
      'doubao-seed-1-6-250615',         // 深度思考稳定版
      'doubao-seed-1-6-vision-250815',  // 视觉理解专项
      'doubao-seed-1-6-flash-250828',   // 高速版
      'doubao-seed-1-6-thinking-250715',// 强思考版
    ],
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey'
  },
  deepseek: {
    id: 'deepseek', name: 'DeepSeek', fullName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    keyUrl: 'https://platform.deepseek.com/api_keys'
  },
  qwen: {
    id: 'qwen', name: '通义千问', fullName: '通义千问 (Alibaba Cloud)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    // 🔧 修复：替换虚构模型 ID 为百炼平台真实 model id
    models: [
      'qwen3.7-max',           // 旗舰推理
      'qwen3.7-plus',          // 能力成本均衡（1M 上下文）
      'qwen3.7-flash',         // 轻量低成本
      'qwen3-max',             // Qwen3 系列稳定版
      'qwen-long',             // 超长文档（1000 万 token）
    ],
    keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key'
  },
  hunyuan: {
    id: 'hunyuan', name: '腾讯混元', fullName: '腾讯混元 (Tencent Hunyuan)',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    // 🔧 修复：补充视觉和翻译模型
    models: [
      'hunyuan-turbos-latest',        // 通用主力
      'hunyuan-a13b',                 // 混合推理 MoE
      'hunyuan-vision',               // 图生文通用
      'hunyuan-t1-vision-20250916',   // 视觉深度思考
      'hunyuan-translation',          // 33 语种翻译
    ],
    keyUrl: 'https://console.cloud.tencent.com/hunyuan/start'
  },
  custom: {
    id: 'custom', name: '自定义', fullName: '自定义 (OpenAI 兼容)',
    baseUrl: '', models: [], keyUrl: ''
  }
};

