import { z } from 'zod';

export const BASE_IPC_RESPONSE_SCHEMA = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    userIdMessage: z.string().optional(),
    details: z.unknown().optional(),
  }).optional(),
  meta: z.object({
    traceId: z.string().uuid(),
    timestamp: z.number(),
    channel: z.string(),
  }).optional(),
});

export type IpcResponse<T = unknown> = {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    userIdMessage?: string;
    details?: unknown;
  };
  meta?: {
    traceId: string;
    timestamp: number;
    channel: string;
  };
};

export const CREATE_ERROR_RESPONSE = (code: string, message: string, userIdMessage?: string): { success: false; error: { code: string; message: string; userIdMessage?: string } } => ({
  success: false,
  error: { code, message, userIdMessage },
});

export const CREATE_SUCCESS_RESPONSE = <T>(data: T): IpcResponse<T> => ({
  success: true,
  data,
});

export const VALIDATION_ERROR_RESPONSE = (message: string): { success: false; error: { code: string; message: string; userIdMessage?: string } } =>
  CREATE_ERROR_RESPONSE('IPC_VALIDATION_ERROR', message, '请求参数校验失败');

export const IPC_ERROR_CODES = {
  VALIDATION_ERROR: 'IPC_VALIDATION_ERROR',
  PIPELINE_NOT_FOUND: 'PIPELINE_NOT_FOUND',
  CHECKPOINT_NOT_FOUND: 'CHECKPOINT_NOT_FOUND',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  PROVIDER_AUTH_FAILED: 'PROVIDER_AUTH_FAILED',
  PROVIDER_QUOTA_EXCEEDED: 'PROVIDER_QUOTA_EXCEEDED',
  DAEMON_UNREACHABLE: 'DAEMON_UNREACHABLE',
  STORAGE_LOW: 'STORAGE_LOW',
  UNKNOWN: 'UNKNOWN',
} as const;
