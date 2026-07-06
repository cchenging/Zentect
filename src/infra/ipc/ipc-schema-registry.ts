import { z } from 'zod';
import { IPC_CHANNELS } from './IpcConstants';

/** channel → Zod schema 注册表 (编译期类型安全 + 运行时 JSON Schema 校验) */
export const SCHEMA_REGISTRY: Record<string, z.ZodTypeAny> = {};

/** V1.0 Pipeline 启动 */
SCHEMA_REGISTRY[IPC_CHANNELS.ENGINE_RUN_V1_PIPELINE] = z.object({
  projectId: z.string().min(1, 'projectId 不能为空'),
  mediaId: z.string().min(1, 'mediaId 不能为空'),
  mediaPath: z.string().min(1, 'mediaPath 不能为空'),
}).strict();

/** Pipeline 恢复 */
SCHEMA_REGISTRY[IPC_CHANNELS.ENGINE_RESUME_PIPELINE] = z.object({
  projectId: z.string().min(1, 'projectId 不能为空'),
  mediaId: z.string().min(1, 'mediaId 不能为空'),
  userInput: z.record(z.string(), z.unknown()).optional(),
}).strict();

/** 查询挂起状态 */
SCHEMA_REGISTRY[IPC_CHANNELS.ENGINE_REQUIRE_USER_ACTION] = z.object({
  projectId: z.string().min(1, 'projectId 不能为空'),
  mediaId: z.string().min(1, 'mediaId 不能为空'),
}).strict();

/** 中止 Pipeline */
SCHEMA_REGISTRY[IPC_CHANNELS.ENGINE_ABORT_PIPELINE] = z.object({
  projectId: z.string().optional(),
  mediaId: z.string().optional(),
}).optional();

/** 恢复探测 */
SCHEMA_REGISTRY[IPC_CHANNELS.PIPELINE_PROBE_RECOVERY] = z.object({
  projectId: z.string().min(1, 'projectId 不能为空'),
}).strict();

/** 继续恢复 */
SCHEMA_REGISTRY[IPC_CHANNELS.PIPELINE_RECOVERY_CONTINUE] = z.object({
  projectId: z.string().min(1, 'projectId 不能为空'),
}).strict();

/** 放弃恢复 */
SCHEMA_REGISTRY[IPC_CHANNELS.PIPELINE_RECOVERY_ABANDON] = z.object({
  projectId: z.string().min(1, 'projectId 不能为空'),
}).strict();

/** 语音克隆删除 */
SCHEMA_REGISTRY['voice:delete-cloned'] = z.object({
  cloneId: z.string().min(1, 'cloneId 不能为空'),
}).strict();

/** 导出剪映 */
SCHEMA_REGISTRY[IPC_CHANNELS.EXPORT_JIANYING] = z.object({
  projectId: z.string().min(1, 'projectId 不能为空'),
}).passthrough();

/** 获取 schema（供 PayloadGuard 使用） */
export function getSchema(channel: string): z.ZodTypeAny | undefined {
  return SCHEMA_REGISTRY[channel];
}

/** 检查 channel 是否已接入校验 */
export function isChannelGuarded(channel: string): boolean {
  return channel in SCHEMA_REGISTRY;
}
