// 📁 路径: src/main/database/repositories/GlobalCharacterRepository.ts
// 🎭 P1 全局人物注册中心 — 跨集/跨项目人物复用的数据访问层
// 核心能力：
//   1. CRUD：创建/查询/更新/删除全局人物
//   2. embedding 比对：用余弦相似度把本地角色 embedding 与全局人物库匹配
//   3. 自动吸收：匹配阈值内则绑定 + 更新中心向量，未匹配则新建全局人物

import { SQLiteConnection } from '../core/SQLiteConnection';
import type { GlobalCharacter } from '../../../shared/types/entities/editor';

/** DB 行结构（下划线列名） */
interface GlobalCharacterRow {
  id: string;
  name: string;
  avatar: string | null;
  embedding_center: string;
  embedding_version: string;
  voice_id: string | null;
  pronoun: string | null;
  description: string | null;
  appearance_count: number;
  source_project_ids: string | null;
  create_time: string;
  update_time: string;
  is_deleted: number;
}

/** 匹配结果 */
export interface MatchResult {
  /** 命中的全局人物（未命中为 null） */
  character: GlobalCharacter | null;
  /** 余弦相似度（0~1，未命中为 0） */
  similarity: number;
  /** 是否新建了全局人物 */
  created: boolean;
}

/** 默认余弦相似度匹配阈值（0.70 = 平衡档，与 step1 聚类后处理一致） */
export const DEFAULT_MATCH_THRESHOLD = 0.70;

/** embedding 模型版本（模型升级时改这里，旧数据自动失效重建） */
export const CURRENT_EMBEDDING_VERSION = 'arcface_v1';

/**
 * 全局人物仓储
 * 处理 global_characters 表的 CRUD 与 embedding 比对
 */
export class GlobalCharacterRepository {
  private get db() {
    return SQLiteConnection.getInstance().getDB();
  }

  /**
   * 查询所有未删除的全局人物（按出现次数降序）
   */
  findAll(): GlobalCharacter[] {
    const rows = this.db.prepare(`
      SELECT * FROM global_characters WHERE is_deleted = 0
      ORDER BY appearance_count DESC, create_time ASC
    `).all() as GlobalCharacterRow[];
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * 按 ID 查单个全局人物
   */
  findById(id: string): GlobalCharacter | null {
    const row = this.db.prepare(`
      SELECT * FROM global_characters WHERE id = @id AND is_deleted = 0
    `).get({ id }) as GlobalCharacterRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  /**
   * 创建新全局人物
   * @param payload 初始字段（id/name/embeddingCenter 必填）
   * @returns 创建后的 GlobalCharacter
   */
  create(payload: {
    id: string;
    name: string;
    embeddingCenter: number[];
    avatar?: string;
    voiceId?: string;
    pronoun?: string;
    description?: string;
    sourceProjectId?: string;
  }): GlobalCharacter {
    const sourceProjectIds = payload.sourceProjectId ? JSON.stringify([payload.sourceProjectId]) : JSON.stringify([]);
    this.db.prepare(`
      INSERT INTO global_characters
        (id, name, avatar, embedding_center, embedding_version, voice_id, pronoun, description,
         appearance_count, source_project_ids, create_time, update_time, is_deleted)
      VALUES
        (@id, @name, @avatar, @embeddingCenter, @embeddingVersion, @voiceId, @pronoun, @description,
         1, @sourceProjectIds, datetime('now', 'localtime'), datetime('now', 'localtime'), 0)
    `).run({
      id: payload.id,
      name: payload.name,
      avatar: payload.avatar ?? null,
      embeddingCenter: JSON.stringify(payload.embeddingCenter),
      embeddingVersion: CURRENT_EMBEDDING_VERSION,
      voiceId: payload.voiceId ?? null,
      pronoun: payload.pronoun ?? null,
      description: payload.description ?? null,
      sourceProjectIds: sourceProjectIds,
    });
    return this.findById(payload.id)!;
  }

  /**
   * 更新全局人物中心向量（吸收新样本后重新计算中心）
   * 中心向量 = 旧中心 × 旧次数 + 新向量 / (旧次数 + 1)
   * @param id 全局人物 ID
   * @param newEmbedding 新样本的归一化 embedding
   * @param newProjectId 出现的新项目 ID（可选，自动追加到 source_project_ids）
   */
  absorbEmbedding(id: string, newEmbedding: number[], newProjectId?: string): void {
    const existing = this.findById(id);
    if (!existing) return;

    const oldCenter = Array.isArray(existing.embeddingCenter)
      ? existing.embeddingCenter
      : (JSON.parse(existing.embeddingCenter as string) as number[]);
    const oldCount = existing.appearanceCount;

    // 增量更新中心向量（归一化加权平均）
    const dim = Math.min(oldCenter.length, newEmbedding.length);
    const newCenter: number[] = new Array(dim);
    for (let i = 0; i < dim; i++) {
      newCenter[i] = (oldCenter[i] * oldCount + newEmbedding[i]) / (oldCount + 1);
    }
    // 重新归一化
    const norm = Math.sqrt(newCenter.reduce((s, v) => s + v * v, 0));
    const normalized = norm > 0 ? newCenter.map((v) => v / norm) : newCenter;

    // 追加项目 ID（去重）
    let sourceProjectIds = Array.isArray(existing.sourceProjectIds)
      ? existing.sourceProjectIds
      : (JSON.parse(existing.sourceProjectIds as string) as string[]);
    if (newProjectId && !sourceProjectIds.includes(newProjectId)) {
      sourceProjectIds = [...sourceProjectIds, newProjectId];
    }

    this.db.prepare(`
      UPDATE global_characters
      SET embedding_center = @embeddingCenter,
          appearance_count = appearance_count + 1,
          source_project_ids = @sourceProjectIds,
          update_time = datetime('now', 'localtime')
      WHERE id = @id
    `).run({
      id,
      embeddingCenter: JSON.stringify(normalized),
      sourceProjectIds: JSON.stringify(sourceProjectIds),
    });
  }

  /**
   * 更新全局人物基本信息（名称/头像/音色/代词/描述）
   */
  update(id: string, fields: Partial<Pick<GlobalCharacter, 'name' | 'avatar' | 'voiceId' | 'pronoun' | 'description'>>): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };

    if (fields.name !== undefined) { sets.push('name = @name'); params.name = fields.name; }
    if (fields.avatar !== undefined) { sets.push('avatar = @avatar'); params.avatar = fields.avatar; }
    if (fields.voiceId !== undefined) { sets.push('voice_id = @voiceId'); params.voiceId = fields.voiceId; }
    if (fields.pronoun !== undefined) { sets.push('pronoun = @pronoun'); params.pronoun = fields.pronoun; }
    if (fields.description !== undefined) { sets.push('description = @description'); params.description = fields.description; }

    if (sets.length === 0) return;
    sets.push("update_time = datetime('now', 'localtime')");
    this.db.prepare(`UPDATE global_characters SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  /**
   * 软删除全局人物
   */
  delete(id: string): void {
    this.db.prepare(`
      UPDATE global_characters SET is_deleted = 1, update_time = datetime('now', 'localtime')
      WHERE id = @id
    `).run({ id });
  }

  /**
   * 🎯 核心能力：用 embedding 在全局人物库中查找最佳匹配
   * @param embedding 待匹配的 512 维归一化向量
   * @param threshold 余弦相似度阈值（默认 0.70）
   * @returns 最佳匹配（character 为 null 表示未命中）
   */
  findBestMatch(embedding: number[], threshold: number = DEFAULT_MATCH_THRESHOLD): { character: GlobalCharacter | null; similarity: number } {
    const allChars = this.findAll();
    if (allChars.length === 0) {
      return { character: null, similarity: 0 };
    }

    let bestChar: GlobalCharacter | null = null;
    let bestSim = 0;

    for (const c of allChars) {
      const center = Array.isArray(c.embeddingCenter)
        ? c.embeddingCenter
        : (JSON.parse(c.embeddingCenter as string) as number[]);
      const sim = cosineSimilarity(embedding, center);
      if (sim > bestSim) {
        bestSim = sim;
        bestChar = c;
      }
    }

    return bestSim >= threshold ? { character: bestChar, similarity: bestSim } : { character: null, similarity: bestSim };
  }

  /**
   * 🎯 核心能力：匹配或创建全局人物
   * - 命中阈值：返回现有人物（不自动 absorb，由调用方决定是否吸收）
   * - 未命中：创建新全局人物
   * @param embedding 本地角色的代表 embedding（聚类中心）
   * @param name 本地角色名（新建时用作全局人物名）
   * @param avatar 本地角色头像（新建时用作全局头像）
   * @param projectId 当前项目 ID
   * @param threshold 匹配阈值
   */
  matchOrCreate(
    embedding: number[],
    name: string,
    avatar: string | undefined,
    projectId: string,
    threshold: number = DEFAULT_MATCH_THRESHOLD,
  ): MatchResult {
    const match = this.findBestMatch(embedding, threshold);
    if (match.character) {
      return { character: match.character, similarity: match.similarity, created: false };
    }

    // 未命中，新建全局人物
    const newId = this.generateId();
    const created = this.create({
      id: newId,
      name,
      embeddingCenter: embedding,
      avatar,
      sourceProjectId: projectId,
    });
    return { character: created, similarity: 0, created: true };
  }

  /**
   * 生成全局人物 ID：gc_ 前缀 + 时间戳 + 随机后缀
   */
  private generateId(): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).substring(2, 8);
    return `gc_${ts}${rand}`;
  }

  /**
   * DB 行映射为 GlobalCharacter（运行时 embeddingCenter/sourceProjectIds 转为数组）
   */
  private mapRow(r: GlobalCharacterRow): GlobalCharacter {
    let embeddingCenter: string | number[];
    try {
      embeddingCenter = JSON.parse(r.embedding_center) as number[];
    } catch {
      embeddingCenter = r.embedding_center;
    }

    let sourceProjectIds: string | string[];
    try {
      sourceProjectIds = r.source_project_ids ? (JSON.parse(r.source_project_ids) as string[]) : [];
    } catch {
      sourceProjectIds = [];
    }

    return {
      id: r.id,
      name: r.name,
      avatar: r.avatar ?? undefined,
      embeddingCenter,
      embeddingVersion: r.embedding_version,
      voiceId: r.voice_id ?? undefined,
      pronoun: r.pronoun ?? undefined,
      description: r.description ?? undefined,
      appearanceCount: r.appearance_count,
      sourceProjectIds,
      createTime: r.create_time,
      updateTime: r.update_time,
    };
  }
}

/**
 * 计算两个向量的余弦相似度
 * 假设输入已归一化（ArcFace 输出本身就是归一化的），但这里仍做归一化以保证健壮性
 * @returns 0~1 的相似度（-1~1 截断到 0~1）
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const dim = Math.min(a.length, b.length);
  if (dim === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < dim; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  // 余弦相似度范围 -1~1，截断到 0~1（人脸匹配不会出现负值，但防御性编程）
  return Math.max(0, Math.min(1, dot / denom));
}
