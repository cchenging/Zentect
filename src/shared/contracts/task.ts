import { z } from 'zod';

export const TASK_EVENT_TYPE = [
  'created',
  'started',
  'progress',
  'completed',
  'failed',
  'degraded',
  'cancelled',
  'recovery_detected',
  'suspended',
  'resumed',
] as const;

export type TaskEventType = (typeof TASK_EVENT_TYPE)[number];

export const TASK_EVENT_TYPE_SCHEMA = z.enum(TASK_EVENT_TYPE);

export const TASK_EVENT_PAYLOAD_SCHEMA = z.object({
  taskId: z.string(),
  type: TASK_EVENT_TYPE_SCHEMA,
  projectId: z.string().optional(),
  pipelineId: z.string().optional(),
  timestamp: z.number(),
  data: z.unknown().optional(),
  progress: z.number().min(0).max(100).optional(),
  message: z.string().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      userIdMessage: z.string().optional(),
      recoverable: z.boolean().optional(),
    })
    .optional(),
});

export type TaskEventPayload = z.infer<typeof TASK_EVENT_PAYLOAD_SCHEMA>;

export const TASK_STATUS = ['idle', 'running', 'paused', 'completed', 'failed', 'cancelled'] as const;

export type TaskStatus = (typeof TASK_STATUS)[number];

export const TASK_STATUS_SCHEMA = z.enum(TASK_STATUS);
