// 📁 路径: src/main/engine/utils/PersonRegistry.ts
// 🎭 人物注册表（person_registry.json）加载与 charId 归一。
//
// 背景：步骤2/3 产出的「人物注册表」把同一人物的**多种字面值**（演员名 / 角色名 / 亲属职务称谓）
// 收敛到一个稳定主键 charId。此前该资产只落盘、无消费方 → 匹配链路的角色维度一直在比"原始字符串"，
// 同一角色写成"宋慧乔 / 宋慧乔饰演的角色 / 女子（宋慧乔）"就互相认不出。本模块把字面值映射为 charId，
// 让 Node（切片/query 侧归一）与 Python daemon（role_score 交集）说同一种语言。
//
// 🛑 用户级铁律（粒度不可信）：人物信息在本项目里**只能作软排信号**，任何时候不得作硬门禁
//   （不得出现 5.0 级惩罚 / 候选剔除）。原因是：切片 characters 由 VLM 帧描述聚合而来，
//   存在"父镜头并集回填"污染（全景切片挂着同场 12 个出场人物），粒度本身不可信；
//   一旦当门禁用，会因误识别把正确切片整段否决。故本模块只产出"归一结果"，消费方一律软加权。
import * as fs from 'fs';
import * as path from 'path';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';
import { PathManager } from '../../utils/pathManager';

/** 注册表内单条别名（可门禁的别名：演员名 / 角色名） */
export interface PersonRegistryAlias {
  /** 字面值（如"宋慧乔""宋慧乔饰演的角色""智恩"） */
  literal: string;
  /** 池中出现次数（仅供诊断/排序参考，不参与命中判定） */
  count?: number;
  /** 别名通道：actor=演员名 / role=角色名 */
  channel?: string;
}

/** 注册表内单个人物 */
export interface PersonRegistryChar {
  /** 稳定主键（如 C_韩智恩），归一后写入切片/query 的 charIds */
  charId: string;
  /** 主名（正式角色名/演员名代主名） */
  canonical?: string;
  /** role=正式角色名 / relation=亲属职务称谓 / actor=演员名代主名 */
  kind?: string;
  /** 可门禁的高置信别名（本模块只用这一层做子串命中） */
  aliasesHigh?: PersonRegistryAlias[];
  /** 外观描述类低置信别名（本任务不消费） */
  aliasesLow?: PersonRegistryAlias[];
  /** 仅 gatingAllowed=true（即 kind=role）才可用于"按角色比对"；其余只能做门禁锚点 */
  gatingAllowed?: boolean;
}

/** 人物注册表根结构 */
export interface PersonRegistry {
  castSource?: string;
  episode?: number;
  chars?: PersonRegistryChar[];
}

/** 切片角色粒度：ok=粒度可信 / union_suspect=疑似父镜头并集回填（角色贡献需降权） */
export type CharGrain = 'ok' | 'union_suspect';

/** 归一结果：charIds + 粒度标记 */
export interface CharIdNormalized {
  charIds: string[];
  charGrain: CharGrain;
}

/** 别名表条目（按 literal 长度降序排列后即天然"长串优先"） */
interface PersonAliasEntry {
  literal: string;
  charId: string;
}

/** 切片 characters 条数超过该阈值即视为疑似父镜头并集回填（粒度不可信） */
const UNION_SUSPECT_THRESHOLD = 3;

/** 注册表加载结果缓存：key = projectId（无 projectId 时用 __default__），避免逐切片重复读盘 */
const registryCache = new Map<string, PersonRegistry | null>();
/** 别名表缓存：与注册表同生命周期 */
const aliasTableCache = new Map<string, PersonAliasEntry[]>();

/**
 * 🎭 加载人物注册表，读取优先级：
 *   ① `data/projects/<projectId>/person_registry.json`（项目级，生产路径，经 PathManager 解析项目真实目录）
 *   ② `<cwd>/temp/scene-log/person_registry.json`（**dev-only 兜底**：temp 目录仅存在于开发态，
 *      发版产物不含该路径；生产环境若命中说明是开发机，不能作为正式数据源）
 *   ③ 都没有 → 返回 null（调用方"不归一"，保持零行为变化）
 *
 * @param projectId 项目 id（缺省时跳过项目级路径，只走 dev 兜底）
 * @returns 注册表对象；未找到/解析失败返回 null（绝不抛错，匹配链路不能被注册表拖垮）
 */
export function loadPersonRegistry(projectId?: string): PersonRegistry | null {
  const cacheKey = projectId && projectId.trim() ? projectId.trim() : '__default__';
  if (registryCache.has(cacheKey)) return registryCache.get(cacheKey)!;

  const candidates: string[] = [];
  // ① 项目级（生产路径）
  if (projectId && projectId.trim()) {
    try {
      candidates.push(path.join(PathManager.getProjectDir(projectId.trim()), 'person_registry.json'));
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[人物归一] 解析项目目录失败，跳过项目级注册表：${e?.message || e}`);
    }
  }
  // ② dev-only 兜底（temp/ 目录不随发版发布，仅开发态存在）
  candidates.push(path.join(process.cwd(), 'temp', 'scene-log', 'person_registry.json'));

  let registry: PersonRegistry | null = null;
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as PersonRegistry;
      if (parsed && Array.isArray(parsed.chars)) {
        registry = parsed;
        AppLogger.info(LOG_TAGS.AI_AGENT,
          `[人物归一] 注册表已加载：${file}（${parsed.chars.length} 个人物）`);
        break;
      }
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[人物归一] 注册表解析失败（${file}）：${e?.message || e}`);
    }
  }
  if (!registry) {
    // 没有任何注册表 → 不归一（零行为变化），仅记一条 info 便于排查
    AppLogger.info(LOG_TAGS.AI_AGENT, '[人物归一] 未找到人物注册表，本次跳过 charId 归一');
  }
  registryCache.set(cacheKey, registry);
  return registry;
}

/**
 * 🎭 构建"字面值 → charId"别名表（供切片侧/query 侧共用同一张表，避免两边口径漂移）：
 *   - **仅收录 gatingAllowed === true**（注册表契约：只有 kind=role 才可用于"按角色比对"；
 *     actor/relation 类人物只能作门禁锚点，放进 charIds 会造成角色维度的假命中）；
 *   - 只用 aliasesHigh（演员名/角色名），不碰 aliasesLow（外观描述，本任务不消费）；
 *   - 结果按 literal 长度**降序**排序：命中时首个满足子串条件的即最长别名，
 *     例如 "宋慧乔饰演的惠媛" 会命中 "宋慧乔饰演的惠媛" 而不会退回更短的 "惠媛"。
 *
 * @param registry 注册表（可为 null）
 * @returns 别名条目数组（长串优先）；无可用条目时返回空数组
 */
export function buildPersonAliasTable(registry: PersonRegistry | null): PersonAliasEntry[] {
  if (!registry || !Array.isArray(registry.chars)) return [];
  const entries: PersonAliasEntry[] = [];
  for (const c of registry.chars) {
    if (!c || c.gatingAllowed !== true) continue;
    const charId = String(c.charId || '').trim();
    if (!charId) continue;
    for (const a of (c.aliasesHigh || [])) {
      const literal = String(a?.literal || '').trim();
      if (!literal) continue;
      entries.push({ literal, charId });
    }
  }
  entries.sort((a, b) => b.literal.length - a.literal.length);
  return entries;
}

/**
 * 🎭 按项目加载别名表（带缓存）：项目级注册表 → dev 兜底 → 空表。
 * 空表意味着"不归一"——归一函数会返回空 charIds，下游自然回退旧行为。
 *
 * @param projectId 项目 id
 * @returns 长串优先的别名条目数组
 */
export function loadPersonAliasTable(projectId?: string): PersonAliasEntry[] {
  const cacheKey = projectId && projectId.trim() ? projectId.trim() : '__default__';
  if (aliasTableCache.has(cacheKey)) return aliasTableCache.get(cacheKey)!;
  const table = buildPersonAliasTable(loadPersonRegistry(projectId));
  aliasTableCache.set(cacheKey, table);
  return table;
}

/**
 * 🎭 在一组文本（字面角色名 / 文案 / 画面意图）中扫描出 charId：
 *   - 只认 aliasesHigh 的 **子串命中**（长串优先，命中即止——"宋慧乔饰演的惠媛"归 C_韩智恩，不会误挂 C_江慧媛）；
 *   - 未命中的文本直接跳过（不瞎猜、不合成）；别名表为空时不归一，返回空数组。
 *
 * @param texts 待扫描文本数组（每项独立扫描）
 * @param aliasTable 长串优先的别名表
 * @returns 去重后的 charId 数组（保持命中顺序）
 */
export function matchCharIdsInTexts(texts: unknown, aliasTable: PersonAliasEntry[]): string[] {
  const list = Array.isArray(texts)
    ? texts.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
    : [];
  const ids = new Set<string>();
  if (aliasTable.length > 0 && list.length > 0) {
    for (const text of list) {
      for (const entry of aliasTable) {
        if (text.includes(entry.literal)) {
          ids.add(entry.charId);
          break; // 长串优先表 → 首个命中即最长别名，避免短别名抢注
        }
      }
    }
  }
  return Array.from(ids);
}

/**
 * 🎭 把一组字面角色名归一为 charIds（切片侧专用）：
 *   - 命中规则见 matchCharIdsInTexts（aliasesHigh 子串命中、长串优先、未命中即丢弃）；
 *   - 同时给出粒度标记 charGrain：原始 characters 条数 > 3 → union_suspect（疑似父镜头并集回填），
 *     否则 ok。该标记供 daemon 对角色贡献降权——粒度不可信，只能软排、绝不硬门禁。
 *
 * @param characters 原始角色字面值数组（可为 undefined）
 * @param aliasTable 长串优先的别名表（为空 = 不归一）
 * @returns { charIds, charGrain }
 */
export function normalizeCharactersToCharIds(
  characters: unknown,
  aliasTable: PersonAliasEntry[],
): CharIdNormalized {
  const list = Array.isArray(characters)
    ? characters.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : [];
  /** 粒度标记：条数过多 → 疑似父镜头并集回填（池子的 characters 存在该污染），软排时需降权 */
  const charGrain: CharGrain = list.length > UNION_SUSPECT_THRESHOLD ? 'union_suspect' : 'ok';
  return { charIds: matchCharIdsInTexts(list, aliasTable), charGrain };
}
