export const FEATURE_FLAGS = {
  USE_V1_PIPELINE_ADAPTER: true,

  USE_SIMPLE_PIPELINE_RUNNER: true,
  USE_PIPELINE_ENGINE: true,        // V1.1 DAG 引擎激活

  USE_CHECKPOINT_REPOSITORY: true,
  USE_PIPELINE_RECOVERY_SERVICE: true,
  USE_TASK_EVENT_BUS: true,
  USE_DATABASE_WRITE_QUEUE: true,

  USE_LOCAL_AI_GATEWAY: true,
  USE_PROVIDER_GATEWAY: true,
  USE_CREDENTIAL_MANAGER: true,

  USE_FRAME_EXTRACTOR_MODULE: true,
  USE_COMPUTE_RESOURCE_MANAGER: true,

  ENABLE_SUSPEND_RESUME: true,

  USE_AI_RUNTIME_MANAGER: true,
  USE_FEEDBACK_BUS: true,
} as const;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;

export function isFeatureEnabled(flag: FeatureFlag): boolean {
  return FEATURE_FLAGS[flag] === true;
}
