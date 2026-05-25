// 📁 路径：src/renderer/src/pages/editor/components/semantic-flow/initialLayout.ts
// 将初始布局数据独立出来，打破循环依赖链

// 节点类型连接规则白名单
export const CONNECTION_RULES: Record<string, string[]> = {
  'sourceNode': ['processNode', 'playerNode'],
  'processNode': ['processNode', 'vectorNode', 'scriptNode', 'playerNode'],
  'vectorNode': ['scriptNode'],
  'scriptNode': ['processNode', 'playerNode'],
  'playerNode': []
};

// 11 节点宏观排版阵列
export const initialNodes = [
  // 阶段 1：拆解层 (X: 50, 350)
  { id: 'n-source', type: 'sourceNode', position: { x: 50, y: 350 }, data: {} },
    { id: 'n-vision-ext', type: 'processNode', position: { x: 350, y: 200 }, data: { actionType: 'vision-extract', label: '视觉抽帧', icon: 'Image', status: 'idle', accent: 'indigo', metaLabel: 'FPS: 1' } },
  { id: 'n-audio-ext', type: 'processNode', position: { x: 350, y: 500 }, data: { actionType: 'audio-separate', label: '音频分离', icon: 'Mic2', status: 'idle', accent: 'blue', metaLabel: 'Vocal/BGM' } },

  // 阶段 2：提取层 (X: 650)
  // 💥 修复：为后续的 AI 分析节点预留标准的 actionType
  { id: 'n-semantic', type: 'processNode', position: { x: 650, y: 50 }, data: { actionType: 'semantic-analyze', label: '视觉语义', icon: 'Eye', status: 'idle', accent: 'purple', metaLabel: 'BLIP-2 解析' } },
  { id: 'n-face', type: 'processNode', position: { x: 650, y: 200 }, data: { actionType: 'face-detect', label: '人物识别', icon: 'UserFocus', status: 'idle', accent: 'purple', metaLabel: 'FaceNet 聚类' } },
  // 💥 修复：注入 actionType: 'asr'
  { id: 'n-asr', type: 'processNode', position: { x: 650, y: 450 }, data: { actionType: 'asr', label: '台词识别', icon: 'Speech', status: 'idle', accent: 'purple', metaLabel: 'Whisper V3' } },
  { id: 'n-sentiment', type: 'processNode', position: { x: 650, y: 600 }, data: { actionType: 'sentiment-analyze', label: '情绪分析', icon: 'Activity', status: 'idle', accent: 'purple', metaLabel: '双轨情绪曲线' } },

  // 阶段 3：枢纽层 (X: 1000)
  { id: 'n-vector', type: 'vectorNode', position: { x: 1000, y: 350 }, data: {} },

  // 阶段 4：中枢层 (X: 1350)
  { id: 'n-script', type: 'scriptNode', position: { x: 1350, y: 320 }, data: { actionType: 'script-gen' } },

  // 阶段 5：合成层 (X: 1750)
  // 💥 修复：注入 actionType: 'tts-generate'
  { id: 'n-tts', type: 'processNode', position: { x: 1750, y: 200 }, data: { actionType: 'tts-synthesize', label: '语音合成', icon: 'AudioWaveform', status: 'idle', accent: 'green', metaLabel: 'CosyVoice' } },
  { id: 'n-player', type: 'playerNode', position: { x: 1750, y: 400 }, data: {}, style: { width: 320 } },
];

// 创建边的辅助函数
const createEdge = (id: string, source: string, target: string, color: string) => ({
  id, source, target, type: 'smoothstep', animated: true,
  style: { stroke: color, strokeWidth: 1.5, opacity: 0.6 }
});

// 精密的工业级流动管线
export const initialEdges = [
  // 蓝线：原始媒体流
  createEdge('e1', 'n-source', 'n-vision-ext', '#3b82f6'),
  createEdge('e2', 'n-source', 'n-audio-ext', '#3b82f6'),
  createEdge('e3', 'n-vision-ext', 'n-semantic', '#3b82f6'),
  createEdge('e4', 'n-vision-ext', 'n-face', '#3b82f6'),
  createEdge('e5', 'n-audio-ext', 'n-asr', '#3b82f6'),
  createEdge('e6', 'n-audio-ext', 'n-sentiment', '#3b82f6'),

  // 紫线：特征向量流入数据库
  createEdge('e7', 'n-semantic', 'n-vector', '#a855f7'),
  createEdge('e8', 'n-face', 'n-vector', '#a855f7'),
  createEdge('e9', 'n-asr', 'n-vector', '#a855f7'),
  createEdge('e10', 'n-sentiment', 'n-vector', '#a855f7'),

  // 绿线：大模型干预与最终合成
  createEdge('e11', 'n-vector', 'n-script', '#22c55e'),
  createEdge('e12', 'n-script', 'n-tts', '#22c55e'),
  createEdge('e13', 'n-tts', 'n-player', '#22c55e'),
  createEdge('e14', 'n-script', 'n-player', '#22c55e'),
];
