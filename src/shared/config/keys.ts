export const CONFIG_KEYS = {
  LLM_PROVIDER: 'llm.provider',
  LLM_DEEPSEEK_API_KEY: 'llm.deepseek.apiKey',
  LLM_DEEPSEEK_MODEL: 'llm.deepseek.model',
  LLM_DEEPSEEK_BASE_URL: 'llm.deepseek.baseUrl',

  TTS_PROVIDER: 'tts.provider',
  TTS_DEFAULT_VOICE_ID: 'tts.defaultVoiceId',
  TTS_EDGE_VOICE: 'tts.edge.voice',
  TTS_MOSS_VOICE_ID: 'tts.moss.voiceId',

  EXPORT_OUTPUT_DIR: 'export.outputDir',
  EXPORT_DEFAULT_FORMAT: 'export.defaultFormat',

  PIPELINE_DEFAULT_FPS: 'pipeline.defaultFps',
  PIPELINE_CHECKPOINT_ENABLED: 'pipeline.checkpointEnabled',
  PIPELINE_RECOVERY_ENABLED: 'pipeline.recoveryEnabled',
  PIPELINE_PARAM_R: 'pipeline.param.retainRatio',
  PIPELINE_PARAM_S: 'pipeline.param.silenceRatio',
  PIPELINE_PARAM_T: 'pipeline.param.ttsCoverage',
  PIPELINE_PARAM_P: 'pipeline.param.paceFactor',

  STORAGE_WORK_DIR: 'storage.workDir',
  STORAGE_MIN_FREE_GB: 'storage.minFreeGb',

  VOICE_CLONE_ENABLED: 'voice.cloneEnabled',
  VOICE_DEFAULT_SAMPLE_RATE: 'voice.defaultSampleRate',

  UI_LANGUAGE: 'ui.language',
  UI_THEME: 'ui.theme',
  UI_MODE: 'ui.mode',
  UI_SKIN: 'ui.skin',
  UI_SCALE: 'ui.scale',
  UI_PARTICLE_STYLE: 'ui.particleStyle',
  UI_FONT_SIZE: 'ui.fontSize',

  FEATURE_EDITOR_ENABLED: 'feature.editor.enabled',
  FEATURE_JOBQUEUE_ENABLED: 'feature.jobqueue.enabled',
  FEATURE_CLI_ENABLED: 'feature.cli.enabled',
} as const;

export type ConfigKey = (typeof CONFIG_KEYS)[keyof typeof CONFIG_KEYS];

export const SENSITIVE_CONFIG_KEYS: readonly string[] = [
  CONFIG_KEYS.LLM_DEEPSEEK_API_KEY,

  // V1.1: 所有第三方 API Key（与 useSettingsManager Schema 对齐）
  'deepseekKey',
  'qwenKey',
  'doubaoKey',
  'tencentKey',
  'openaiKey',
  'fishKey',
  'doubaoTtsToken',
] as const;

export function isSensitiveConfig(key: string): boolean {
  return (SENSITIVE_CONFIG_KEYS as readonly string[]).includes(key);
}
