/**
 * 编辑器步骤 i18n 词典扩展
 * 导入到 zh-CN.ts 中合并
 */
export const EDITOR_STEP_I18N: Record<string, string> = {
  // 步骤1 - 素材分析
  'editor.step1.frames.title': '关键帧提取',
  'editor.step1.frames.statusDone': '已提取 {count} 张关键帧',
  'editor.step1.frames.statusFail': '提取失败',
  'editor.step1.frames.statusIdle': '等待管线执行',
  'editor.step1.audio.title': '音频分离',
  'editor.step1.audio.separated': '人声台词 + 背景音乐',
  'editor.step1.audio.empty': '暂未分离音频',
  'editor.step1.audio.extractAction': '分离音频',
  'editor.step1.asr.title': 'ASR 台词识别',
  'editor.step1.asr.confirmed': '已确认',
  'editor.step1.asr.modified': '已修改',
  'editor.step1.asr.pending': '待确认',
  'editor.step1.faces.title': '人物识别',
  'editor.step1.faces.statusDone': '检测到 {count} 个角色',
  // 步骤2 - 画面描述
  'editor.step2.title': 'VLM 画面描述',
  'editor.step2.storyLine': '故事脉络',
  'editor.step2.empty': '执行素材分析后，画面描述将在此展示',
  // 步骤3 - 解说文案
  'editor.step3.title': 'AI 解说文案',
  'editor.step3.styleLabel': '风格',
  'editor.step3.paramR': '经典保留',
  'editor.step3.paramS': '原台词保留',
  'editor.step3.paramT': 'TTS 覆盖',
  'editor.step3.paramP': '节奏因子',
  'editor.step3.rateLabel': '语速控制',
  'editor.step3.charsPerSec': '{rate}字/秒',
  'editor.step3.overflowWarning': '{overflow} 段超时，{warning} 段接近超时',
  'editor.step3.regenerate': '重新生成',
  'editor.step3.matchVision': '匹配画面',
  // 步骤4 - 配音合成
  'editor.step4.title': 'TTS 配音合成',
  'editor.step4.engineLabel': '引擎',
  'editor.step4.voiceLabel': '角色选择',
  'editor.step4.rateLabel': '语速',
  'editor.step4.synthesizing': '合成中...',
  'editor.step4.startSynthesis': '开始合成',
  'editor.step4.success': '合成成功',
  'editor.step4.failed': '合成失败',
  'editor.step4.pending': '待合成',
  'editor.step4.preview': '试听',
  // 步骤5 - 镜头匹配
  'editor.step5.title': '镜头匹配',
  'editor.step5.confirmed': '已确认',
  'editor.step5.confirmAction': '确认对齐',
  'editor.step5.replaceAction': '替换画面',
  'editor.step5.rematchAction': '重新匹配',
  'editor.step5.scoreLabel': '匹配度',
  'editor.step5.dragHint': '拖拽卡片可调整镜头顺序',
  // 通用
  'editor.common.step': '步骤 {current}/{total}',
  'editor.common.start': '启动',
  'editor.common.next': '下一步',
  'editor.common.manual': '手动',
  'editor.common.auto': '自动',
  'editor.common.retry': '重试',
};