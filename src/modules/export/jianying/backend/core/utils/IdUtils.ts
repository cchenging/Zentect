// 📁 路径：src/modules/export/jianying/backend/core/utils/IdUtils.ts
// ID 工具：生成剪映统一格式的 hex / UUID / child_id

import * as crypto from 'crypto';

/** 生成 32 位十六进制 ID（剪映 segment / track / material 统一格式） */
export function genHexId(): string {
  return crypto.randomBytes(16).toString('hex');
}

/** 生成顶层草稿 UUID（剪映要求大写 UUID 格式） */
export function genDraftUuid(): string {
  return crypto.randomUUID().toUpperCase();
}

/**
 * 将 32 位大写十六进制素材 id 转为剪映 child_id 的小写 UUID 格式（8-4-4-4-12）。
 *
 * @param hexId - 32 位大写 hex 素材 id
 * @returns 例如 "C6BD877018CD4FDF8AE739B1E937DDED" → "c6bd8770-18cd-4fdf-8ae7-39b1e937dded"
 */
export function toUuid(hexId: string): string {
  const lower = hexId.toLowerCase();
  return `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20)}`;
}