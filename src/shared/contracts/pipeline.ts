import { z } from 'zod';

export const PIPELINE_STEP_STATUS = [
  'pending',
  'running',
  'completed',
  'failed',
  'degraded',
  'cancelled',
  'config_missing',
  'suspended',
] as const;

export type PipelineStepStatus = (typeof PIPELINE_STEP_STATUS)[number];

export const PIPELINE_STEP_STATUS_SCHEMA = z.enum(PIPELINE_STEP_STATUS);

export const PIPELINE_STEP_SCHEMA = z.object({
  stepId: z.string(),
  label: z.string(),
  status: PIPELINE_STEP_STATUS_SCHEMA,
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      userIdMessage: z.string().optional(),
      recoverable: z.boolean().optional(),
    })
    .optional(),
  degradedReason: z.string().optional(),
});

export type PipelineStep = z.infer<typeof PIPELINE_STEP_SCHEMA>;

export const PIPELINE_PROGRESS_PAYLOAD_SCHEMA = z.object({
  pipelineId: z.string(),
  projectId: z.string(),
  currentStep: PIPELINE_STEP_SCHEMA,
  steps: z.array(PIPELINE_STEP_SCHEMA),
  overallProgress: z.number().min(0).max(100),
  estimatedRemainingSec: z.number().optional(),
  requireUserAction: z
    .object({
      type: z.enum(['confirm_cast', 'fix_credentials', 'fill_config']),
      message: z.string(),
      payload: z.unknown().optional(),
    })
    .optional(),
});

export type PipelineProgressPayload = z.infer<typeof PIPELINE_PROGRESS_PAYLOAD_SCHEMA>;

export const CHECKPOINT_SCHEMA = z.object({
  id: z.string(),
  pipelineId: z.string(),
  projectId: z.string(),
  stepId: z.string(),
  status: PIPELINE_STEP_STATUS_SCHEMA,
  checkpointData: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.number(),
  updatedAt: z.number().optional(),
});

export type PipelineCheckpoint = z.infer<typeof CHECKPOINT_SCHEMA>;
