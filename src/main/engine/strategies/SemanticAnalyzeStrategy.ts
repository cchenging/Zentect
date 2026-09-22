import { BaseNodeStrategy, ExecutionContext } from './BaseNodeStrategy';
import { PipelineTask } from '../../../shared/types';
import { AIDaemon } from '../../core/AIDaemon';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';
import { dehydrateMagicPath } from '../utils/pathUtils';
import { VideoChunkRepository } from '../../database/repositories/VideoChunkRepository';
import { BgmBeatRepository } from '../../database/repositories/BgmBeatRepository';
import { LLMFactory } from '../adapters/LLMFactory';
import { promisePool } from '../../utils/async';
import { VisionExtractStrategy } from './VisionExtractStrategy';
import * as path from 'path';
import * as fs from 'fs';
// 🎬 OP/ED 片头片尾裁剪策略（P0 手动裁剪 / P1 源头裁剪）
import { resolveForMedia, applyToChunks, isTitleCardText, type ResolvedTrim } from '../utils/MediaTrimPolicy';
import { TrimmedSourceResolver } from '../utils/TrimmedSourceResolver';
/** 🎭 人物归一（2026-09-18）：注册表字面值 → charId 映射（切片侧 + query 侧共用同一张表） */
import { loadPersonAliasTable, normalizeCharactersToCharIds, matchCharIdsInTexts } from '../utils/PersonRegistry';
import { PathManager } from '../../utils/pathManager';
import { JobScheduler } from '../../core/JobScheduler'; // 🔧 R12（PR-3）：任务准入合并 —— 检测步骤1 是否在跑
import { ComputeResourceManager } from '../../core/ComputeResourceManager'; // 🔧 R12（PR-3）：激活 canStartNewTask 全局资源准入信号
/** 🎯 匹配单位 SSOT（2026-09-18）：sentence 档把 query 折叠成"一个完整句一条"，出结果再按单位回填到全部碎片 */
import { collapseShotsToMatchUnits, resolveScriptMatchUnitMode } from '../../../shared/utils/scriptMatchUnit';
/** 🎬 A1·S2 分镜师 Agent（§24.16-A）：为每个母句开 α 真工单 ShotSpec，并按 matchUnitId 回填到 query */
import { StoryboardAgent, resolveStoryboardOpen, syncStoryboardModeFile } from '../storyboard/StoryboardAgent';
import type { ShotSpec } from '../../../shared/contracts/shotSpec';

/**
 * 镜头匹配策略：三维一体弹性时间轴对齐
 * 维度一：解说词与视频片段的 CLIP 语义相似度
 * 维度二：刚性音频时长与视频片段原长的时差惩罚
 * 维度三：BGM 鼓点磁吸吸附权重
 * 使用匈牙利算法求解全局最优排他性匹配
 */

/** 切片描述聚合条数上限：同一物理镜头内帧描述去重后按频次降序取前 8 条拼接，
 * 避免数百帧描述全部拼接导致 CLIP 512-token 截断淹没关键道具/动作语义。 */
const MAX_AGGREGATED_DESC_SEGS = 8;

/** 🎬 场景切片产物 Schema 版本指纹（切分参数 + 算法版本）：
 *  参与 video_chunks / video_chunk_parts 缓存 key 与前端回传切片池的 schema 校验。
 *  背景（2026-09-04 用户指正）：切片参数（threshold / 候选段粒度）是硬编码、随代码升级演进，
 *  若缓存 key 只含「视频路径 + projectId + OP/ED 窗口」，改参数后旧缓存仍会被命中 → 新逻辑完全失效。
 *  故版本必须进 key：bump 本常量（v1→v2→…）即让旧 schema 缓存全部失效重切；未 bump 则正常复用。
 *  ⚠️ 常量必须与下方 detect_scene_chunks 请求字面量、resources/scripts/video_analyzer.py 的
 *     SceneChunkReq 默认值及切分/候选段生成逻辑保持一致——改任一侧切分行为时同步 bump。 */
/** 切片缓存 schema 版本：升级切分参数/坐标体系时必须 bump（旧缓存自动失效重切）。
 *  🔧 v2（2026-09-05）：净池从「body 平移」重构为「源坐标过滤」——缓存内 startMs/endMs 恒为【源坐标】，
 *    旧 v1 缓存的 body 坐标数据坐标体系不同，必须整体失效，否则会被误当作源坐标消费（预览/导出错位）。 */
const SCENE_CHUNK_SCHEMA_VERSION = 'scene_chunk_v2_th0.3_min1_max3_seg3_src';

/** 🎬 给切片数组统一打上当前 schema 版本标记（浅拷贝注入 chunkSchema 字段，不污染原对象）：
 *  写入 DB 缓存 / 回传前端快照前调用，使缓存与快照携带版本号；
 *  下游 ownPool 校验据此识别「旧 schema 切出的切片」，杜绝跨版本误复用。 */
function tagChunkSchema<C extends object>(chunks: C[]): C[] {
  if (!Array.isArray(chunks)) return chunks;
  return chunks.map((c) => {
    if (!c || typeof c !== 'object') return c;
    if ((c as any).chunkSchema === SCENE_CHUNK_SCHEMA_VERSION) return c;
    return { ...(c as any), chunkSchema: SCENE_CHUNK_SCHEMA_VERSION };
  });
}

/** 🎬 步骤5 匹配诊断信息（随节点结果返回，前端透出为用户可读原因，避免"静默空卡/零命中"无从排查） */
export interface MatchStepDiagnostics {
  /** 用户可读的根因提示（空数组 = 本次匹配无异常） */
  warnings: string[];
  /** 匹配概况（供前端展示 / 日志排障） */
  totalQueries: number;
  matchedCount: number;
  chunkCount: number;
  matchSegmentCount: number;
  originalQueryCount: number;
  originalMatchedCount: number;
}

/**
 * 组装步骤5 匹配诊断：把「切片池空 / KM 全未命中 / 原声定位失败」等根因收敛为 warnings 随结果透出。
 * @param o.matches 最终组装结果（含原声定位段 + KM 命中段 + 未匹配空段）
 * @param o.chunks 物理镜头切片池
 * @param o.matchSegments KM 匹配候选段池
 * @param o.originalQueryCount 原声段落总数（用于统计定位失败数）
 * @param o.originalMatchedCount 原声定位成功数
 * @param o.emptyQueryWarning 无解说文案（totalQueries=0）时的唯一提示文案
 */
export function buildMatchStepDiagnostics(o: {
  matches: any[];
  chunks: any[];
  matchSegments: any[];
  originalQueryCount: number;
  originalMatchedCount: number;
  emptyQueryWarning?: string;
}): MatchStepDiagnostics {
  const { matches, chunks, matchSegments, originalQueryCount, originalMatchedCount, emptyQueryWarning } = o;
  const totalQueries = matches.length;
  const matchedCount = matches.filter((m) => m && String(m.mediaId || m.chunkId || '').trim().length > 0).length;
  const chunkCount = Array.isArray(chunks) ? chunks.length : 0;
  const matchSegmentCount = Array.isArray(matchSegments) ? matchSegments.length : 0;
  const warnings: string[] = [];
  if (totalQueries === 0) {
    if (emptyQueryWarning) warnings.push(emptyQueryWarning);
  } else if (chunkCount === 0) {
    warnings.push('未检测到视频切片：请确认已完成素材分析（步骤1-2），或媒体文件可被正常解析后重试');
  } else if (matchSegmentCount === 0) {
    warnings.push('已检测到镜头但匹配候选段为空：切片池不完整，建议重新运行素材分析');
  } else if (matchedCount === 0) {
    warnings.push('语义匹配未命中任何画面：可尝试重新匹配；持续为空请检查解说文案与切片画面描述是否对应');
  }
  const locateFailed = Math.max(0, originalQueryCount - originalMatchedCount);
  if (locateFailed > 0) {
    warnings.push(`原声段定位失败 ${locateFailed}/${originalQueryCount} 段（已回退画面匹配，不再保留原片原声）`);
  }
  return {
    warnings, totalQueries, matchedCount, chunkCount, matchSegmentCount,
    originalQueryCount, originalMatchedCount,
  };
}

/**
 * 🎬 候选切片 body→源坐标还原（2026-09-05 模式 A 契约）：TrimmedSourceResolver 成功裁剪路径
 * 的 daemon 产物坐标相对 body 裁剪文件（0 起）、filePath 指向裁剪临时文件。落库/消费前必须归一为
 * 【源坐标 + filePath=源视频】：startMs/endMs 整体 +trimStartMs，filePath/coverPath 参照不变、
 * filePath 若存在则改指源视频路径。纯坐标映射（window 外已在裁剪时排除，无需再滤）。
 * @param items chunks 或 matchSegments（形状任意，只要含 startMs/endMs）
 * @param trimStartMs OP 结束点（= body 起点相对源文件的偏移）
 * @param sourcePath 源视频物理路径（覆盖 filePath 指向，保证"坐标↔素材"同源自洽）
 */
function toSourceCoords<T extends { startMs: number | string; endMs: number | string; filePath?: string }>(
  items: T[],
  trimStartMs: number,
  sourcePath: string,
): T[] {
  if (!Array.isArray(items) || !trimStartMs) return items;
  return items.map((c) => {
    if (!c) return c;
    const s = Number(c.startMs) || 0;
    const e = Number(c.endMs) || s;
    const out: any = {
      ...c,
      startMs: Math.round(s + trimStartMs),
      endMs: Math.round(e + trimStartMs),
    };
    if (typeof c.filePath === 'string' && c.filePath) out.filePath = sourcePath;
    return out;
  });
}

/** 🎬 无信息帧剔除（2026-09-04 观察项 1.3 落地）：从 KM 候选池剔除两类"不可匹配帧"——
 *  ① 无任何画面信息：description 与 keywords 均空（黑场/纯字幕/转场帧，VLM 无内容可描述）；
 *  ② 字卡/字幕帧：description 命中字卡特征（片名/第X集/字幕/出品/演职员 等，判据与 MediaTrimPolicy 同源）。
 *  这两类帧没有可被解说词匹配的画面语义，留着只会让"介绍人物/字幕画面"被选中（用户反馈"第一段匹配切片还有文字介绍"）。
 *  仅作用于候选段 matchSegments；匹配结果（matches/导出）由候选派生，剔除后自然不再进匹配与导出。
 *  调用前提（2026-09-05）：仅当候选池存在带描述/关键词段（desc 覆盖率 >0，即语义聚合数据对本池有效）时调用，
 *  此时 desc 全空的段才是真无信息帧；若整池 desc 覆盖率 0（无聚合数据），由调用方保留全池走 KM 图像语义，不调本函数。
 *  保守原则：只在「描述全空」或「明确命中字卡特征」时剔除，有正常画面描述的静止/特写帧不受影响。 */
function stripUninformativeMatchSegments(segments: any[]): { kept: any[]; dropped: number } {
  if (!Array.isArray(segments)) return { kept: segments || [], dropped: 0 };
  const kept: any[] = [];
  let dropped = 0;
  for (const s of segments) {
    if (!s || typeof s !== 'object') continue;
    const desc = String(s.description || '').trim();
    let kws: string[] = [];
    if (Array.isArray(s.keywords)) kws = (s.keywords as string[]).filter((x) => typeof x === 'string');
    else if (typeof s.keywords === 'string' && s.keywords) kws = [s.keywords];
    if (!desc && kws.length === 0) { dropped++; continue; }   // 无任何画面信息（黑场/纯字幕/转场）
    if (desc && isTitleCardText(desc + ' ' + kws.join(' '))) { dropped++; continue; } // 字卡/字幕帧
    kept.push(s);
  }
  return { kept, dropped };
}

/** 🔬 步骤2 逐帧 VLM 描述来源归集（2026-09-05 修复「候选 884→0」根因）：
 *  BaseNodeStrategy 只把 params 与上游 mergedInputs 平铺为扁平 task，帧描述从未以顶层键
 *  frameDescriptions 注入过，读取该键恒为空 → 帧描述聚合永不执行 → 候选池 desc 全空 →
 *  stripUninformative 把整池误判为"空描述无信息帧"剔光。
 *  实际存在三种同构来源（每帧含 timeMs/description/emotion/downstream/characters）：
 *   - task.frameDescriptions：历史契约兜底（无写入方，保留以防外部直接注入）；
 *   - task.frames：完整管线 step2（VisionExtractStrategy.return.frames）经 context.bus 平铺进下游；
 *   - task.visionResult.frames：单步重跑步骤5 时渲染层注入的 vlmFrames（usePipelineOrchestrator step5）。
 *  三种来源可能同帧重复（vlmFrames 源自 step2 result.frames），按 id/时间戳+描述 去重合并。 */
function collectFrameDescriptions(task: any): any[] {
  const sources = [task.frameDescriptions, task.frames, task.visionResult?.frames];
  const merged: any[] = [];
  const seen = new Set<string>();
  for (const arr of sources) {
    if (!Array.isArray(arr)) continue;
    for (const f of arr) {
      if (!f || typeof f !== 'object') continue;
      const idKey = (typeof f.id === 'string' && f.id)
        ? f.id
        : `t${Math.round(Number(f.timeMs) || 0)}#${String(f.description || '')}`;
      if (seen.has(idKey)) continue;
      seen.add(idKey);
      merged.push(f);
    }
  }
  return merged;
}

/** ================================================
 *  🎬 批1（2026-09-06）语义翻译层：SCENE_GROUPS 场景组词表 + 场景/情绪状态提取工具
 *  ⚠️ 词表须与 daemon resources/scripts/timeline_solver.py 的 SCENE_GROUPS 保持一致（改词须两端同步）
 *   - 切片侧：chunk.scene（帧场景众数 / desc「场景:」正则回捞）→ matchSceneGroup 映射到组
 *   - query 侧：buildMatchQueries 用同一 matchSceneGroup 从 visualIntent → 正文 推导 sceneGroup
 *   - 仅组等值命中（query.sceneGroup == chunk.sceneGroup）才在 daemon 触发加成 / 窗口豁免
 *     （R2-1 防裸子串假阳性：'车'不伤'工厂车间'、'室'不伤'室外操场'，只做完整组词包含）
 * ================================================ */
const SCENE_GROUPS: Record<string, string[]> = {
  教室系: ['教室内', '教室一角', '教室过道', '教室后排', '明亮教室', '教室课桌', '讲台', '黑板前', '课堂', '教室'],
  医院系: ['医院', '病房', '医院走廊', '病床前', '诊室', '候诊区'],
  居室系: ['卧室', '客厅', '房间', '宿舍', '昏暗卧室'],
  // 🏨 酒店系（P0-1 2026-09-16 新增）：实测本片主线场景（酒店前台/酒店走廊/VIP接待处…）
  //   此前完全不在词表 → 整段落"无组→中性"。长词优先保证 '前台接待处' 不被 '前台' 抢走。
  酒店系: ['酒店前台', '酒店走廊', '酒店大堂', '酒店房间', '酒店', '套房', '客房', 'VIP休息室',
          'VIP接待处', '前台接待处', '接待处', '前台', '大堂'],
  办公系: ['办公室', '办公桌', '会议室', '办公桌前', '办公桌后', '银行'],
  车间系: ['车间', '工厂', '流水线', '厂房'],
  餐饮系: ['餐厅包间', '餐厅内景', '餐厅', '餐桌', '饭店', '食堂', '厨房', '宴席', '室内餐桌'],
  户外系: ['户外街道', '街道', '马路', '街头', '广场', '操场', '室外'],
  // 🚉 交通枢纽系（2026-09-16 新增）：交通**场地**（非载具内部）。
  //   ⚠️ 与「载具系」必须分开成组：若机舱与机场同组，场景命中加成会反向强化
  //   "机舱对白配到机场大厅"这类空间穿越错配。
  //   P0-1 补：机场通道/机场跑道/登机口（实测出现但此前落无组）。
  交通枢纽系: ['机场候机厅', '机场大厅', '机场通道', '机场跑道', '登机口', '候机厅', '候机楼', '航站楼',
              '机场', '车站', '火车站', '码头', '港口', '地铁站'],
  // 🚗 载具系（2026-09-16 新增）：载具内部空间（机舱/车厢/船舱…），长词优先命中。
  //   实测痛点：'飞机客舱' 原本落入空组 → 空间约束失效 → 机舱对白错配机场大厅。
  //   P0-1 补：座位/窗边/过道/后座等载具内部**部位**词（实测出现但此前落无组）。
  载具系: ['飞机客舱', '飞机机舱', '飞机座位', '机舱座位', '机舱窗边', '机舱过道', '车内后座',
          '机舱内', '客舱内', '机舱', '客舱', '车内', '车厢', '驾驶座', '副驾驶', '座位靠背',
          '出租车', '公交车', '地铁', '列车', '火车', '船舱', '甲板', '游轮',
          '飞机', '轿车', '船'],
  场馆系: ['教室大厅', '复古大厅', '昏暗大厅', '大厅空镜', '大厅', '会场', '舞台'],
  其他室内: ['昏暗室内', '室内近景', '室内特写', '室内', '楼梯间'],
};

/** 「场景:值」正则回捞（与 daemon 端 _map_scene_group 前处理口径一致）：
 *  值域截止到下一字段名（主体/情绪/光影/空间/看点/道具/造型/环境/关键词）/ 分号 / 换行 / 串尾；
 *  排除 ，,；;\n —— 情绪值内含逗号不得吞进场景值（R2-5 正则防空）。
 *  适用于 desc 的 `…动作 场景:昏暗室内 主体:老人…` 与帧描述同构形态。
 *  ⚠️ §20 第4步：新增 造型/环境 两个字段名（描述装配新增），若不加入截止表，
 *     当主体/情绪/光影/空间/道具全空时场景值会把「造型:…环境:…」整段吞掉。 */
const SCENE_VALUE_RE = /(?:场景|地点)[:：]\s*([^，,；;\n]+?)(?=\s*(?:主体|情绪|光影|空间|看点|道具|造型|环境|关键词)[:：]|[；;]|\n|$)/u;

/** 从 VLM 结构化文本中正则回捞「场景」值；未命中返回空串（不编造假场景）。 */
function extractSceneFromDescription(desc: string | null | undefined): string {
  if (!desc) return '';
  const m = String(desc).match(SCENE_VALUE_RE);
  if (!m || !m[1]) return '';
  return m[1].trim();
}

/** 场景文本 → 场景组（R2-1 防假阳性核心）：
 *  - 只做「完整组词包含」匹配，绝不做单字/过短子串匹配；
 *  - 命中多个组时取【最长组词】所属组（'教室大厅' 同时含 教室/大厅 → 归词更长的 场馆系）；
 *  - 无任何组词命中返回 ''（中性，场景维度不加不减，不影响正确性）。 */
function matchSceneGroup(sceneText: string | null | undefined): string {
  const text = String(sceneText || '').trim();
  if (!text) return '';
  let bestGroup = '';
  let bestLen = -1;
  for (const [group, tokens] of Object.entries(SCENE_GROUPS)) {
    for (const tok of tokens) {
      if (tok && tok.length > bestLen && text.includes(tok)) {
        bestGroup = group;
        bestLen = tok.length;
      }
    }
  }
  return bestGroup;
}

/** 🎭 批1 情绪状态词表（输出=既有情绪类别名，Node 把类别名直发 daemon 的 moodIntent 字段）：
 *  类别名与 daemon EMOTION_CATEGORIES 完全同源（'紧张悬疑'含'紧张'等，_normalize_emotion 归一恒等），
 *  因此无需在两端维护第二套情绪词表——复用既有 5+中性 分类与 EMOTION_COMPAT 冲突抑制（R2-4）。 */
const MOOD_WORDS: Record<string, string[]> = {
  紧张悬疑: ['紧张', '不安', '害怕', '恐惧', '惊悚', '惊恐', '焦虑', '忐忑', '压迫', '屏息', '诡异', '惊险', '揪心', '惶恐', '阴森', '诡秘'],
  悲伤沉重: ['悲伤', '难过', '压抑', '沉重', '哀伤', '凄凉', '绝望', '心碎', '落寞', '沮丧', '忧郁', '怅然', '阴沉', '阴郁', '悲痛', '无奈', '眼泪', '泪水'],
  愤怒激昂: ['愤怒', '生气', '怒火', '暴怒', '愤慨', '激动', '激烈', '激昂', '爆发', '咆哮', '狠戾', '杀气'],
  欢快轻松: ['欢快', '轻松', '开心', '高兴', '喜悦', '愉快', '兴奋', '雀跃', '欢呼', '热闹', '喧闹', '温馨', '甜蜜', '幸福', '美好', '温情', '浪漫', '俏皮'],
  平静舒缓: ['平静', '安静', '宁静', '静谧', '静默', '沉寂', '安详', '平缓', '温和', '从容', '沉稳', '淡然', '安逸', '悠远', '寂静'],
  中性: ['冷静', '平淡', '客观', '普通', '日常', '寻常', '中性', '面无表情'],
};

/** 从自由文本中取情绪类别：扫描 MOOD_WORDS 命中位置，preferLast=true 取【靠后终点态】（正文转折取尾：
 *  "喧闹…瞬间安静"→平静舒缓）；preferLast=false 取【最先出现态】（VI 画面语言情绪词通常居前、代表目标画面基调）。
 *  命中多个类别时按位置排序，同一类别取最早出现词；无任何命中返回 ''（交给 q.emotion 兜底）。 */
function moodIntentForText(text: string | null | undefined, preferLast: boolean): string {
  const s = String(text || '');
  if (!s.trim()) return '';
  const hits: Array<{ cat: string; pos: number }> = [];
  for (const [cat, toks] of Object.entries(MOOD_WORDS)) {
    let bestPos = -1;
    for (const tk of toks) {
      const p = s.indexOf(tk);
      if (p >= 0 && (bestPos < 0 || p < bestPos)) bestPos = p;
    }
    if (bestPos >= 0) hits.push({ cat, pos: bestPos });
  }
  if (hits.length === 0) return '';
  hits.sort((a, b) => (preferLast ? b.pos - a.pos : a.pos - b.pos));
  return hits[0].cat;
}

/** 🎞️ 候选段独立封面完整性校验（2026-09-05 封面错位根治）：
 *  Python daemon 真检测时会给每个 3s 匹配候选段抽独立封面（文件名 basename 以 seg_ 开头）；
 *  而 Node 侧 buildMatchSegmentsFromChunks 兜底重建的候选段没有独立封面（继承镜头级 chunk 封面或空）。
 *  仅当 matchSegments 每段都携带 Python 独立封面时才允许其**写入 DB 缓存**——
 *  否则脏池（封面=镜头起点帧、段起点在后）固化后再被命中，卡片封面与预览起点错位反复出现。 */
function matchSegmentsHaveOwnCovers(segs: any[]): boolean {
  if (!Array.isArray(segs) || segs.length === 0) return false;
  return segs.every((s) => {
    const cp = String(s && s.coverPath || '');
    if (!cp.trim()) return false;
    const base = cp.split(/[\\/]/).pop() || '';
    return base.startsWith('seg_');
  });
}

export class SemanticAnalyzeStrategy extends BaseNodeStrategy {
  readonly nodeType = 'semantic-analyze';

  /** 🔬 Step1 Layer1 段落级时间窗（决策 #1 冻结值，与 daemon 端 _query_window 口径一致）：
   *  前探 30s 覆盖铺垫，后延 60s 覆盖冲突发酵。 */
  private static readonly WINDOW_LEAD_MS = 30000;
  private static readonly WINDOW_TAIL_MS = 60000;

  /** 🔬 Step1 Layer1：为 query 附加段落级时间窗闭包 [windowStartMs, windowEndMs]（决策 #1）。
   *  由源锚 startMs/durationMs 派生（与 daemon 派生口径一致），daemon 端优先生效此显式窗口；
   *  源锚无效时保留为 0，daemon 回退其内部兜底逻辑。 */
  private static attachQueryWindow(query: any): any {
    const start = Number(query?.startMs) || 0;
    const dur = Number(query?.durationMs) || 0;
    return {
      ...query,
      windowStartMs: Math.max(0, start - SemanticAnalyzeStrategy.WINDOW_LEAD_MS),
      windowEndMs: start + dur + SemanticAnalyzeStrategy.WINDOW_TAIL_MS,
    };
  }

  /**
   * 🔧 R12（PR-3）：任务准入合并等待。
   *  - 阶段一：等 JobScheduler 步骤1（素材提取）结束（上限 30 分钟，超时抛错）；
   *  - 阶段二：等系统资源允许启动新任务（ComputeResourceManager.canStartNewTask，上限 2 分钟）。
   */
  private async waitForTaskAdmission(): Promise<void> {
    const scheduler = JobScheduler.getInstance();
    const crm = ComputeResourceManager.getInstance();

    const step1Deadline = Date.now() + 30 * 60 * 1000;
    while (scheduler.isStep1Running()) {
      if (Date.now() > step1Deadline) {
        throw new Error('等待步骤1（素材提取）完成超时，请稍后重试');
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    const crmDeadline = Date.now() + 2 * 60 * 1000;
    while (!crm.canStartNewTask().allowed) {
      if (Date.now() > crmDeadline) {
        throw new Error('系统资源繁忙，无法启动镜头匹配，请稍后重试');
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  protected async performTask(
    task: PipelineTask,
    _context: ExecutionContext,
    cacheDir: string,
    onProgress: (p: number, s: string, results?: any) => void
  ): Promise<any> {
    /** BaseNodeStrategy 将 params 和 mergedInputs 合并为扁平对象，直接从顶层取值 */
    /** 💥 关键修复：mediaPath 可能是 magic:// 协议路径（hydrate 后跨盘符转 magic://local/），
     *  必须脱水为物理路径再传给 daemon，否则 detect_scene_chunks 的 os.path.exists 失败 → 切片池为空 */
    const mediaPath = task.mediaPath ? dehydrateMagicPath(task.mediaPath) : undefined;
    if (!mediaPath) throw new Error('语义分析失败：未找到媒体文件路径');

    /** 🔧 R12（PR-3）：任务准入合并 —— 步骤1（素材提取）在跑则排队等待其完成，
     *  避免步骤5 镜头匹配与步骤1 同时吃满 CPU/IO；随后激活 ComputeResourceManager.canStartNewTask
     *  （此前无消费方）做全局资源准入，资源过载则继续排队。 */
    await this.waitForTaskAdmission();

    /** 🔧 P1 #7：管线一开始就异步预调 daemon（/health + waitForReady 自动点火），
     *   不阻塞参数准备 / 帧描述准备，让步骤2 detect_beats/detect_scene_chunks 到达时 daemon 已热。 */
    const warmDaemonPromise = AIDaemon.getInstance().ensureWarm();

    /** 从前端注入的参数中获取解说文案段落 */
    const scriptShots: any[] = task.scriptShots || [];
    /** TTS 配音刚性时长数据 */
    const ttsDurations: any[] = task.ttsDurations || [];
    /** ASR 原声时间轴：原声段落（keepOriginalAudio）按原声文本定位原片时间段 */
    const asrLines: any[] = task.asrLines || [];
    /** BGM 信息 */
    const bgmInfo: { id: string; filePath: string } | null = task.bgmInfo
      ? { ...task.bgmInfo, filePath: dehydrateMagicPath(task.bgmInfo.filePath) }
      : null;

    onProgress(5, '正在准备镜头匹配数据...');

    /** 如果没有解说文案，无法匹配 */
    if (scriptShots.length === 0) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, '[镜头匹配] 未找到解说文案，跳过匹配');
      return {
        matches: [],
        segments: [],
        diagnostics: buildMatchStepDiagnostics({
          matches: [], chunks: [], matchSegments: [], originalQueryCount: 0, originalMatchedCount: 0,
          emptyQueryWarning: '未找到解说文案段落：请先运行步骤3 生成解说词后再匹配',
        }),
      };
    }

    /** 步骤1：检测 BGM 鼓点节拍（SQLite 持久化缓存优先，命中后秒级复用）
     *  确保进入 daemon POST 前已完成预热（如还没结束，await 最多等 ensureWarm 走完） */
    await warmDaemonPromise;
    let bgmBeats: number[] = [];
    let bgmBpm = 0;
    if (bgmInfo?.filePath && fs.existsSync(bgmInfo.filePath)) {
      onProgress(10, '正在检测 BGM 节拍...');
      try {
        /** 🔧 P1 #6：先查 SQLite BGM 节拍缓存，命中秒级返回；文件被替换后 size/mtimeMs
         *   指纹不一致自动失效重算，不会读到过期节拍。 */
        const bgmBeatRepo = new BgmBeatRepository();
        const cachedBeats = bgmBeatRepo.getValid(bgmInfo.filePath);
        if (cachedBeats && cachedBeats.beatsSec.length > 0) {
          bgmBeats = cachedBeats.beatsSec;
          bgmBpm = cachedBeats.bpm;
          AppLogger.info(LOG_TAGS.AI_AGENT,
            `[镜头匹配] 命中 BGM 节拍 DB 缓存，共 ${bgmBeats.length} 个节拍，BPM=${bgmBpm}`);
        } else {
          const beatResult = await AIDaemon.getInstance().post('/api/audio/detect_beats', {
            file_path: bgmInfo.filePath,
          });
          const beatData = beatResult?.data || beatResult;
          bgmBeats = (beatData.beatGridMs || beatData.onsetMs || []).map((ms: number) => ms / 1000);
          bgmBpm = Number(beatData.tempo) || 0;
          if (bgmBeats.length > 0) {
            bgmBeatRepo.save(bgmInfo.filePath, bgmBeats, bgmBpm);
          }
          AppLogger.info(LOG_TAGS.AI_AGENT,
            `[镜头匹配] BGM 节拍检测完成，共 ${bgmBeats.length} 个节拍，BPM=${bgmBpm}`);
        }
      } catch (e: any) {
        AppLogger.warn(LOG_TAGS.AI_AGENT, `[镜头匹配] BGM 节拍检测失败: ${e.message}，继续无 BGM 模式`);
      }
    }

    /** 步骤2：检测视频场景切片（DB 持久化缓存优先，命中秒级复用，未命中调 daemon 后写库）
     *  🎬 阶段 B 三层分离：Python 侧一次性产出 chunks（Layer1 镜头级）+ matchSegments（Layer2 匹配候选级）。
     *    - chunks        → 帧描述聚合目标 + 前端切片池展示 + 导出蒙太奇衔接判断依据
     *    - matchSegments → KM 匹配候选池（每 3s 一段，含 parentChunkId，天然支持 SAME_SCENE 识别）
     *  🎬 P0 OP/ED 裁剪：先读 projects.extraction_config.mediaTrim 算出 trim（毫秒）；
     *     缓存隔离 key = mediaPath + "#trim_sXX_eYY"，避免"同一视频不同 trim 值读到错缓存"；
     *     若命中的是"未 trim 原始缓存"，直接 Node 侧 applyToChunks 平移过滤（秒级完成，不重切片 80s）。 */
    onProgress(20, '正在检测视频场景切片...');
    // 2.1 先解析 OP/ED 裁剪配置（projects.extraction_config.mediaTrim）
    /** 🔧 projectId 解析（2026-09-04 根因修复）：引擎把 projectId 放在 ExecutionContext(_context) 而非 task.params 上，
     *  旧实现只读 task.projectId → 恒为空 → resolveForMedia('') 查不到 mediaTrim → needTrim=false → OP/ED 从不裁切、
     *  全片含片头切片进入匹配与导出（实证：DB 缓存 key 无 projId 前缀、无 trim 指纹）。
     *  修复：task 缺失时回退 _context.projectId（引擎 runPipeline 顶层 projectId 真实来源）。 */
    const projectId: string = String((task as any).projectId ?? (task as any).project ?? (_context as any)?.projectId ?? '');
    const mediaAssetId: string = (task as any).mediaId || (task as any).assetId || '';
    const trim: ResolvedTrim = resolveForMedia(projectId, mediaAssetId);
    const needTrim = trim.trimStartMs > 0 || trim.trimEndMs > 0;
    const { chunks: _probeForFingerprint, trimFingerprint } = applyToChunks([], trim);
    void _probeForFingerprint;
    // 2.2 视频切片缓存 key：携带【schema 版本指纹】+【源文件内容指纹】+「trim 隔离 key」，避免缓存错配
    //   - schema 版本（SCENE_CHUNK_SCHEMA_VERSION）：切分参数/算法升级时 bump，旧 schema 缓存自动失效重切
    //   - 源文件指纹（size+mtime）：同名文件被覆盖成新内容（如同路径换集）时自动失效重切，
    //     杜绝旧切片与画面错位（参照 BgmBeatRepository 的 size/mtime 指纹防过期）
    //   - trim 指纹：同一视频不同 OP/ED 窗口隔离（命中 raw 后 Node 侧实时平移，不重切 80s）
    const videoRepo = new VideoChunkRepository();
    const sourceFileFingerprint = (() => {
      try {
        const st = fs.statSync(mediaPath);
        return `f${st.size}_${Math.round(st.mtimeMs)}`;
      } catch {
        // stat 失败（文件缺失/被占用）→ 无指纹，detect 本身也会失败，由错误路径暴露
        return 'f0_0';
      }
    })();
    const rawCacheKey = `${projectId ? `${projectId}:` : ''}${mediaPath}#${SCENE_CHUNK_SCHEMA_VERSION}#${sourceFileFingerprint}`;
    const trimAwareCacheKey = needTrim ? `${rawCacheKey}#${trimFingerprint}` : rawCacheKey;
    let chunks: any[] = [];
    let matchSegments: any[] = [];
    /** 🔧 缓存隔离：记录本次切片调用传给 daemon 的 mediaId（=视频/裁剪后路径），
     *  提升到方法作用域，供下方 KM 请求补传一致的 mediaId/projectId，让 daemon 兜底缓存 key 同构命中。 */
    let sceneMediaId = mediaPath;
    try {
      /** 🎬 方向3（跨项目切片污染纵深防御）：优先复用前端注入的本项目已保存切片池
       *  （task.videoChunks ← step5State.videoChunks ← metadata.videoChunks ← 本项目上一次步骤5 结果回传）。
       *  仅无 OP/ED 裁剪时启用（源坐标=body 坐标，复用零坐标风险）；needTrim 时 metadata 切片
       *  坐标契约不透明（可能 body 也可能源坐标），仍走下方 trimAware 缓存链路，避免坐标二次平移错配。
       *  契约校验与 P1 一致：非空且含 colorHistogram，不满足按"错就错"原则降级。 */
      const ownPool: any[] = Array.isArray(task.videoChunks) ? task.videoChunks : [];
      /** 🎬 schema 版本校验（2026-09-04）：方向3 复用"本项目上次步骤5 结果"，但快照可能由旧版本代码切出。
       *  若池内存在标注了 chunkSchema 且 ≠ 当前版本 → 版本不匹配整体弃用（走 DB 缓存/重切）；
       *  无标注的存量历史快照视为与本项目同构放行复用（避免老项目 rematch 触发 80s 重切）。
       *  复用前统一补打当前版本标记，回传快照后下游即版本可判。 */
      const ownPoolHasStaleSchema = ownPool.some(
        (c: any) => c && c.chunkSchema && c.chunkSchema !== SCENE_CHUNK_SCHEMA_VERSION,
      );
      const ownPoolUsable = !needTrim && !ownPoolHasStaleSchema && ownPool.length > 0
        && ownPool.some((c: any) => Array.isArray(c.colorHistogram) && c.colorHistogram.length > 0);
      if (ownPoolUsable) {
        chunks = tagChunkSchema(ownPool);
        matchSegments = SemanticAnalyzeStrategy.buildMatchSegmentsFromChunks(chunks);
        AppLogger.info(LOG_TAGS.AI_AGENT,
          `[镜头匹配] 方向3: 优先复用本项目已保存切片池 ${chunks.length} 个镜头，候选段 ${matchSegments.length} 个（跳过 daemon 跨项目缓存）`);
      } else {
      /** 🔧 先查 SQLite 切片缓存：先命中「trimAware key」（精确值），再回落到 raw key 做 Node 侧平移裁剪 */
      let cached = videoRepo.getByMediaId(trimAwareCacheKey) || (needTrim ? videoRepo.getByMediaId(rawCacheKey) : null);
      /** 🔧 缓存 key 兼容回退（2026-09-04 收紧为「同 schema 版本」）：历史代码曾以裸物理路径（无 projectId 前缀）
       *  写库，但那份缓存无版本号、schema 不可判 → 按"错就错"原则不再信任（宁重切一次），
       *  杜绝旧参数切出的切片顶掉当前逻辑。此处仅回退「裸 path + 当前 schema 版本」的 key，
       *  防御未来无 projectId 场景的同版本写入。 */
      const bareSchemaKey = mediaPath ? `${mediaPath}#${SCENE_CHUNK_SCHEMA_VERSION}` : '';
      if (!cached && bareSchemaKey && rawCacheKey !== bareSchemaKey) {
        cached = videoRepo.getByMediaId(bareSchemaKey);
        if (cached) {
          AppLogger.info(LOG_TAGS.AI_AGENT,
            `[镜头匹配] 命中裸路径同 schema 缓存（key=物理路径#${SCENE_CHUNK_SCHEMA_VERSION}）镜头 ${cached.chunks.length} 个`);
        }
      }
      /** 🎨 P1 缓存契约校验：切片须含 colorHistogram（相邻切片色调连续性特征，P1 新增）。
       *  旧版缓存缺该字段，按"错就错"原则视为数据契约不满足，失效重切（不能静默跳过色调维度）。 */
      const cacheUsable = cached && cached.chunks.length > 0
        && cached.chunks.some((c: any) => Array.isArray(c.colorHistogram) && c.colorHistogram.length > 0)
        /** 🛑 2026-09-05 自愈：新 schema 缓存若缺候选段（matchSegments 空）→ 准入守卫曾拒存（候选段无 Python 独立封面），
         *  复用它会反复兜底重建出无独立封面的脏候选（UI 表现为"匹配到了却不显示封面"）。视为契约不满足 → 强制真重切；
         *  仅"旧缓存无 chunkSchema 标注"的历史形态保留兜底重建（ADR B-3）。 */
        && !(cached.chunks.some((c: any) => c && c.chunkSchema === SCENE_CHUNK_SCHEMA_VERSION)
             && (!cached.matchSegments || cached.matchSegments.length === 0));
      if (cacheUsable && cached) {
        let workingChunks = cached.chunks;
        let workingSegs = cached.matchSegments && cached.matchSegments.length > 0 ? cached.matchSegments : [];
        // 如果是 needTrim 且命中的是 raw key（没带 trim 指纹），就在 Node 侧实时平移过滤，不用重切 80s！
        if (needTrim && (cached as any).trimFingerprint !== trimFingerprint) {
          const trimmedChunks = applyToChunks(workingChunks, trim);
          const trimmedSegs = applyToChunks(workingSegs, trim);
          workingChunks = trimmedChunks.chunks;
          workingSegs = trimmedSegs.chunks;
          AppLogger.info(LOG_TAGS.AI_AGENT, `[镜头匹配] OP/ED: 命中原始缓存(raw key)，Node 侧实时平移 chunks=${workingChunks.length} segs=${workingSegs.length} (${trimFingerprint})`);
          // 写一份带 trim key 的缓存，下次直接命中不用再平移
          // 🔧 2026-09-05：仅当候选段携带 Python 独立封面（seg_*）才固化，防脏池（镜头封面）落库再命中
          if (workingChunks.length > 0) {
            videoRepo.save(trimAwareCacheKey, workingChunks,
              matchSegmentsHaveOwnCovers(workingSegs) ? workingSegs : []);
          }
        } else {
          AppLogger.info(LOG_TAGS.AI_AGENT, `[镜头匹配] OP/ED: 命中缓存 key=${trimAwareCacheKey.slice(-22)} chunks=${workingChunks.length} segs=${workingSegs.length}`);
        }
        chunks = tagChunkSchema(workingChunks);
        matchSegments = workingSegs;
        /** 阶段 B 兼容：v1 老缓存只有 chunks 数组（无 matchSegments）→ 用 Node 侧兜底生成候选段，
         *  避免老缓存全部失效强制重切片（ADR B-3 要求的降级分支）。 */
        if (matchSegments.length === 0) {
          matchSegments = SemanticAnalyzeStrategy.buildMatchSegmentsFromChunks(chunks);
        }
        AppLogger.info(LOG_TAGS.AI_AGENT, `[镜头匹配] 命中视频切片 DB 缓存，镜头 ${chunks.length} 个，匹配候选段 ${matchSegments.length} 个`);
      } else {
        if (cached && cached.chunks.length > 0) {
          const lacksColor = !cached.chunks.some((c: any) => Array.isArray(c.colorHistogram) && c.colorHistogram.length > 0);
          const newSchemaMissingSegs = cached.chunks.some((c: any) => c && c.chunkSchema === SCENE_CHUNK_SCHEMA_VERSION)
            && (!cached.matchSegments || cached.matchSegments.length === 0);
          AppLogger.info(LOG_TAGS.AI_AGENT,
            lacksColor
              ? `[镜头匹配] 旧版切片缓存缺色调特征（colorHistogram），按契约校验失效，重新切片以启用衔接优化`
              : newSchemaMissingSegs
                ? `[镜头匹配] 缓存缺候选段（matchSegments 空 = 独立封面准入守卫拒存），按契约失效强制重切以恢复 seg 独立封面`
                : `[镜头匹配] 切片缓存契约不满足，重新切片`);
        }
        const chunksDir = path.join(cacheDir, 'video_chunks');
        /** 🎬 P1-4 OP/ED 源头裁剪：needTrim 时先按 body 窗口切视频（TrimmedSourceResolver），
         *  只切片正剧段，chunks/segments 天然 body 坐标（省 OP/ED 算力 + 免除 Node 侧平移）。
         *  mediaId 用切片路径做缓存隔离，避免不同 trim 值/整段缓存错配；resolve 失败回退整段。 */
        let sceneSource = mediaPath;
        sceneMediaId = mediaPath;
        /** 🔧 OP/ED 裁剪是否失败（2026-09-04 阶段1-防线）：失败回退整段后，daemon 产物是"整段源坐标"（0 起含 OP/ED），
         *  必须在下方 detect 后 Node 侧平移成 body 再入库/进 KM——否则全片脏切片会被写进 body 语义的 trimAware key，
         *  导致片头字卡/出品帧污染候选池与导出。成功裁剪时产物天然 body，不误标。 */
        let trimSourceFailed = false;
        if (needTrim) {
          try {
            const sceneTrim = await TrimmedSourceResolver.resolve({
              projectId, mediaId: mediaAssetId, mediaPath,
              mode: 'body', ext: '.mp4',
              getFfmpegPath: () => PathManager.getBinPath('ffmpeg.exe'),
            });
            if (sceneTrim.shouldTrim && sceneTrim.trimmedPath && sceneTrim.trimmedPath !== mediaPath) {
              sceneSource = sceneTrim.trimmedPath;
              sceneMediaId = sceneTrim.trimmedPath;
              AppLogger.info(LOG_TAGS.AI_AGENT,
                `[镜头匹配] OP/ED: 场景切片按 body 窗口裁剪源 ${sceneTrim.window.durationSec !== undefined ? sceneTrim.window.durationSec.toFixed(1) : '?'}s（偏移 ${sceneTrim.window.offsetSec.toFixed(1)}s）`);
            } else if (needTrim) {
              // resolve 返回但不产生裁剪文件：等同未裁剪，视为失败路径（避免把整段当 body 误存）
              trimSourceFailed = true;
            }
          } catch (e: any) {
            trimSourceFailed = true;
            AppLogger.warn(LOG_TAGS.AI_AGENT, `[镜头匹配] OP/ED 场景切片源裁剪失败，回退整段(detect 后 Node 平移成 body): ${e.message}`);
          }
        }
        const chunkResult = await AIDaemon.getInstance().post('/api/video/detect_scene_chunks', {
          file_path: sceneSource,
          output_dir: chunksDir,
          threshold: 0.3,
          min_chunk_duration_sec: 1.0,
          /** 阶段 B：max_chunk_duration_sec 保留请求契约兼容（Python 侧不再据此细分镜头）；
           *  target_seg_duration_sec=3 让 Python 侧按 3s 拆分生成 matchSegments 候选段。 */
          max_chunk_duration_sec: 3.0,
          target_seg_duration_sec: 3.0,
          /** body 窗口切片时用切片路径做缓存 key（天然 body 坐标），整段时用视频路径（源坐标） */
          /** 🔧 缓存隔离：传 projectId 让 daemon 素材池缓存按项目隔离 */
          projectId,
          mediaId: sceneMediaId,
        }, { timeout: 900000 });
        const chunkData = chunkResult?.data || chunkResult;
        /** 🛑 2026-09-05 修复（封面缺失总根因）：daemon detect 响应为
         *  { success, data: <chunks 数组>, chunks: <chunks 数组>, matchSegments: <独立 seg 数组> }——
         *  data 是 chunks 的直传数组，从 data.matchSegments 读取**恒为 undefined**，
         *  导致 Python 的独立候选段（带 seg_ 独立封面）从未被采用，全部落入下方 TS 兜底重建
         *  （封面继承镜头级/非首段为空）→ UI"匹配到了却不显示封面 / 封面≠预览"。
         *  候选段必须在**响应顶层**取；data 仅用于兼容旧版裸数组响应（data=数组时无顶层 matchSegments 才回退）。 */
        const segs = Array.isArray((chunkResult as any)?.matchSegments) ? (chunkResult as any).matchSegments : [];
        chunks = tagChunkSchema(Array.isArray(chunkData)
          ? chunkData
          : (Array.isArray((chunkData as any)?.chunks) ? (chunkData as any).chunks : []));
        /** 阶段 B 兜底：daemon 为旧版本（仅返回数组、无顶层 matchSegments）时原地生成候选段，避免候选池契约缺项 */
        matchSegments = segs.length > 0 ? segs : SemanticAnalyzeStrategy.buildMatchSegmentsFromChunks(chunks);
        /** 🔧 OP/ED 坐标归一（2026-09-05 模式 A：候选池恒为【源坐标】）：
         *  - needTrim 且裁剪失败回退整段 → daemon 产物是整段源坐标（含 OP/ED），
         *    用 applyToChunks 做【源坐标过滤】剔除窗外 + 跨边界收紧（不平移），chunks 与 daemon segs 分别滤；
         *  - 确保净化后的候选永远不含片头字卡/片尾 credits，且 filePath 与坐标同为源视频参照。 */
        if (needTrim && trimSourceFailed && chunks.length > 0) {
          chunks = applyToChunks(chunks, trim).chunks;
          matchSegments = matchSegments.length > 0 ? applyToChunks(matchSegments, trim).chunks
            : SemanticAnalyzeStrategy.buildMatchSegmentsFromChunks(chunks);
          chunks = tagChunkSchema(chunks);
          AppLogger.info(LOG_TAGS.AI_AGENT,
            `[镜头匹配] OP/ED: 整段回退产物已 Node 源坐标过滤（剔除 OP/ED/credits）chunks=${chunks.length} segs=${matchSegments.length}`);
        }
        /** 🎬 OP/ED 源头裁剪（TrimmedSourceResolver 裁 body 文件）：daemon 产物是 body 坐标（相对裁剪文件 0 起），
         *  且 chunk.filePath 指向裁剪临时文件。按模式 A 契约，候选池必须落库为【源坐标 + filePath=源视频】：
         *  这里一次性把产物还原成源坐标（+trimStartMs）并把 filePath 改指源视频——预览/导出对源视频按源坐标直接取窗。 */
        if (needTrim && !trimSourceFailed && chunks.length > 0) {
          chunks = toSourceCoords(chunks, trim.trimStartMs, mediaPath);
          matchSegments = toSourceCoords(matchSegments, trim.trimStartMs, mediaPath);
          AppLogger.info(LOG_TAGS.AI_AGENT,
            `[镜头匹配] OP/ED: 场景切片按 body 窗口裁剪完成，已还原源坐标 chunks=${chunks.length} segs=${matchSegments.length}`);
        }
        /** 切片成功后持久化到 SQLite：
         *   - 无 trim 时写原始 key（供后续无 trim/任意 trim 回落使用）
         *   - 有 trim 时额外写 trimAware key，下次命中秒级跳过平移 */
        if (chunks.length > 0) {
          try {
            // 🔧 2026-09-05：候选段须携带 Python 独立封面（seg_*）才固化 matchSegments；
            //   Node 兜底重建的段（封面继承镜头级/空）不落库，防脏池命中后封面与段起点错位
            const segsToPersist = matchSegmentsHaveOwnCovers(matchSegments) ? matchSegments : [];
            // 无 trim（整段源坐标切片）永远先写 raw key，让后续不同 trim 值都能回落 Node 平移
            if (!needTrim) { videoRepo.save(rawCacheKey, chunks, segsToPersist); }
            // 🎬 P1-4：needTrim 时切片源已是 body 窗口，产物为 body 坐标 → 只写 trimAware key；
            //  不再写 raw key（raw key 语义=整段源坐标，body 坐标数据写入会导致无 trim/其他 trim 回落时坐标错配）
            if (needTrim) { videoRepo.save(trimAwareCacheKey, chunks, segsToPersist); }
          } catch (e: any) {
            AppLogger.warn(LOG_TAGS.AI_AGENT, `[镜头匹配] 写切片缓存失败: ${e.message}`);
          }
        }
        AppLogger.info(LOG_TAGS.AI_AGENT, `[镜头匹配] 场景切片检测完成，镜头 ${chunks.length} 个，匹配候选段 ${matchSegments.length} 个`);
      }
      }
    } catch (e: any) {
      /** 🛑 2026-09-05 B1：场景切片检测失败直接抛错暴露（此前仅 warn 后继续空池跑 KM → 全空假结果）。
       *  切片是步骤5 的全部素材基础，检测失败必须让 UI 看到失败与原因。 */
      AppLogger.error(LOG_TAGS.AI_AGENT, `[镜头匹配] 场景切片检测失败（fail-fast）: ${e?.message || e}`);
      throw new Error(`镜头匹配失败（场景切片检测异常）: ${e?.message || e}`);
    }

    /** 步骤2 逐帧 VLM 描述聚合：按时间轴把帧描述归入切片（chunk.description），
     *  供 daemon 做"文案↔切片描述"文本语义匹配——复用步骤2 已花成本的画面理解，零额外 VLM 调用；
     *  无描述切片退化为纯图像语义。
     *  🎭 P0 意境维度：同步聚合帧情绪/景别为切片情绪标签（chunk.emotion/shotType），
     *  供 daemon 做"文案情绪↔画面情绪"匹配（文案段落 emotion 来自步骤3 LLM 生成，帧 emotion 来自步骤2 VLM 结构化输出）。
     *  🎬 P0 OP/ED：先平移 frameDescs.timeMs -= trimStartMs，再删除 OP/ED 区间外的帧描述，
     *     保证帧时间轴与 chunks（已平移）完全对齐，避免双指针聚合空归。 */
    const frameDescsRaw: { timeMs: number; description: string; emotion?: string; shotType?: string; cameraMovement?: string; scene?: string; characters?: string[];
      shotStyle?: string; dramaticConflict?: string; spatialRelation?: string; visualAtmosphere?: string;
      primarySubject?: string; secondarySubjects?: string[]; interaction?: string;
      keyProps?: string; costume?: string; weatherEnv?: string }[] = collectFrameDescriptions(task).map((f: any) => {
      /** 🎥 运镜描述回捞（2026-09-16 第2步修复）：帧级没有 downstream 时，从描述前缀【景别/运镜】回捞。
       *  实测根因：切片级 cameraMovement 恒为 0（metadata.videoChunks 连键都不存在），而 shotType/scene
       *  各有"描述回捞"故幸免——因为下游帧对象可能**不带 downstream**（结构断层），
       *  凡只依赖 downstream 的字段就会静默归零。此处为运镜补上与 shotType 同源的兜底。 */
      const camFromDesc = (() => {
        const m = /^[【\[]([^】\]]*)[】\]]/.exec(String(f?.description || '').trim());
        if (!m) return undefined;
        const parts = m[1].split(/[/／]/);
        const mv = (parts.length > 1 ? parts[parts.length - 1] : '').trim();
        return /^(固定|推|拉|摇|移|跟|升降|手持)$/.test(mv) ? mv : undefined;
      })();
      /** 合并角色名：VLM downstream.characters（画面中实际看到的） ∪ 人脸识别帧级锚定 f.characters
       *  双重来源取并集去重，避免任何一方缺失导致角色维度漏数据。
       *  无效占位值（"无/路人/群众"等）在步骤2 normalizeDownstreamFields 中已转 undefined，
       *  这里只需纯去重合并，无需再过滤。 */
      const mergedRoles = new Set<string>();
      if (Array.isArray(f?.downstream?.characters)) {
        for (const r of f.downstream.characters) {
          if (typeof r === 'string' && r.trim()) mergedRoles.add(r.trim());
        }
      }
      if (Array.isArray(f?.characters)) {
        for (const r of f.characters) {
          if (typeof r === 'string' && r.trim()) mergedRoles.add(r.trim());
        }
      }
      return {
        /** 🎬 坐标系契约（P1-5 修正）：帧时间戳的坐标系由上游是否落库决定，聚合前自适应统一为 body：
         *   - 步骤1 落库 frames_time_ms = 【源坐标】（原视频绝对时间，body + sourceOffsetMs，首帧 ≥ trimStartMs）
         *   - 步骤1 未落库（frames_time_ms 空）时，步骤2 回退 estimatedInterval 估算时间轴 = 【body 坐标】（首帧 0 起）
         *   chunk/matchSegments 在 OP/ED 裁剪下恒为【body 坐标】。
         *   因此不能无条件 -trimStartMs（会对估算/body 坐标二次平移放大错位）：
         *   仅在帧时间明显是源坐标（首帧 ≥ OP 结束点）时转 body；否则保持原样。 */
        timeMs: Math.max(0, Number(f.timeMs || 0)),
        description: f.description,
        emotion: f.emotion,
        /** 🔧 P0 修复：FrameDetail 顶层无 shotType 字段，真实值在 downstream.shotType 中
         *  （VisionExtractStrategy.normalizeDownstreamFields 从 jsonItem.shotType 提取）。
         *  兜底 f.shotType 以防万一有外部直接注入的老数据结构。 */
        shotType: f?.downstream?.shotType || f.shotType,
        /** 🎥 运镜方式（固定/推/拉/摇/移）：downstream → 顶层 → **描述前缀回捞**（三级兜底，
         *  前两级都依赖 downstream 存在，实测下游帧对象可能不带 downstream 导致恒为 0） */
        cameraMovement: f?.downstream?.cameraMovement || f.cameraMovement || camFromDesc,
        /** 🎬 批1 场景（N1）：**口径统一（§20 第1步）**——优先取 VLM 原生 `downstream.scene`
         *  （v4 起 665/665 帧都有，`normalizeDownstreamFields` 已透传），仅在其缺失时才退回
         *  description 的「场景:」正则回捞（与 daemon _map_scene_group 前处理同源，R2-5 防空正则）。
         *  旧实现无条件走正则 → 切片 scene 与帧级原生值可能不一致（同字段两套口径）。 */
        scene: (f?.downstream?.scene ? String(f.downstream.scene).trim() : '')
          || extractSceneFromDescription(f?.description),
        characters: mergedRoles.size > 0 ? Array.from(mergedRoles) : undefined,
        // 🎬 第2步（2026-09-16）：补齐此前**从未进入切片**的 7 个结构化字段（导演/编剧/美术维度）。
        //   全部沿用"downstream 优先 + 顶层兜底"双源读取；值为空则留 undefined，不造占位假值。
        shotStyle: f?.downstream?.shotStyle || f.shotStyle,
        dramaticConflict: f?.downstream?.dramaticConflict || f.dramaticConflict,
        spatialRelation: f?.downstream?.spatialRelation || f.spatialRelation,
        visualAtmosphere: f?.downstream?.visualAtmosphere || f.visualAtmosphere,
        primarySubject: f?.downstream?.primarySubject || f.primarySubject,
        // 👀 A域 v7：主体视线朝向（补丁14 跳轴守卫）——帧级聚合数据源，"downstream 优先 + 顶层兜底"
        eyelineDirection: f?.downstream?.eyelineDirection || f.eyelineDirection,
        secondarySubjects: (Array.isArray(f?.downstream?.secondarySubjects) && f.downstream.secondarySubjects.length > 0)
          ? f.downstream.secondarySubjects
          : (Array.isArray(f?.secondarySubjects) && f.secondarySubjects.length > 0 ? f.secondarySubjects : undefined),
        interaction: f?.downstream?.interaction || f.interaction,
        // 🎬 §20 第4步（2026-09-16）：道具/服装/环境三字段（v5 prompt 起采集）→ 聚合落切片，
        //   供后续"道具实体锚定 / 同场换装 / 天气影调一致"判据消费（本步只做落库采集，不新增打分）。
        keyProps: f?.downstream?.keyProps || f.keyProps,
        costume: f?.downstream?.costume || f.costume,
        weatherEnv: f?.downstream?.weatherEnv || f.weatherEnv,
      };
    });
    /** 🎬 帧时间坐标统一为【源坐标】（2026-09-05 模式 A）：候选切片坐标恒为源，帧描述须同参照才能聚合。
     *  ⚠️ 这不是坐标"猜测"——上游只有两个确定轴态：
     *  - 步骤1 落库 frames_time_ms = 【源坐标】→ 首帧 ≥ trimStartMs，原样使用；
     *  - 步骤1 未落库、步骤2 回退 estimatedInterval 估算时间轴 = 【body 坐标】→ 首帧必然 < trimStartMs（0 起）。
     *  两态互斥且首帧位置可判定（≥ trimStartMs ↔ 源；< trimStartMs ↔ body），故仅两种分支、无歧义；
     *  无裁剪时源=body（偏移 0），转换恒等、无副作用。 */
    const frameDescs = (needTrim && frameDescsRaw.length > 0 && frameDescsRaw[0].timeMs >= 0
      && frameDescsRaw[0].timeMs < trim.trimStartMs)
      ? frameDescsRaw.map((f) => ({ ...f, timeMs: Math.round((f.timeMs || 0) + trim.trimStartMs) }))
      : frameDescsRaw;
    if (frameDescs.length > 0 && chunks.length > 0) {
      /**
       * 双指针聚合帧描述到切片：sortedDescs 与 videoChunks 都按时间有序，
       * 维护 [winLeft, winRight) 滑窗，每帧只入/出窗一次，复杂度从 O(C×F) 降到 O(F + C)。
       * 出入窗时用 Map 维护引用计数，避免旧实现中"同一段描述在多个 chunk 内共享时出窗误删"
       * 以及 indexOf 每次 O(n) 的性能损耗。
       */
      const sortedDescs = [...frameDescs].sort((a, b) => a.timeMs - b.timeMs);

      // 聚合器（带引用计数）：
      //   descCounts: description → 引用次数；descOrder: 按首次出现顺序排列；
      //   emotionCounts / shotTypeCounts: 标签 → 引用次数（天然可复用）；
      //   roleCounts: 角色名 → 引用次数。
      const descCounts = new Map<string, number>();
      const descOrder: string[] = [];
      const emotionCounts = new Map<string, number>();
      const shotTypeCounts = new Map<string, number>();
      const cameraMovementCounts = new Map<string, number>();
      const sceneCounts = new Map<string, number>();
      const roleCounts = new Map<string, number>();
      // 🎬 第2步（2026-09-16）新增字段聚合器：
      //   字符串字段取**众数**（引用计数，同一镜头内多帧描述同一属性时取最高频值）；
      //   数组字段（secondarySubjects 陪体）取**并集**（陪体是稀疏信息，并集比众数更不易丢）。
      const extraStrCounts: Record<string, Map<string, number>> = {
        shotStyle: new Map(),          // 单人/双人对峙/过肩镜头/群戏（导演：正反打结构）
        dramaticConflict: new Map(),   // 剧情张力/看点（编剧：情绪能量）
        spatialRelation: new Map(),    // 人物空间关系/构图（美术/导演）
        visualAtmosphere: new Map(),   // 光影/色调/氛围（美术：影调连续性）
        primarySubject: new Map(),     // 主焦点（导演：主陪体对齐）
        eyelineDirection: new Map(),   // 视线朝向（补丁14 跳轴守卫）
        interaction: new Map(),        // 交互动作
        // 🎬 §20 第4步（2026-09-16）：道具/服装/环境（v5 prompt 起采集，只落库不做新打分）
        keyProps: new Map(),           // 关键道具（道具锚定维度）
        costume: new Map(),            // 服装造型（同场换装判据）
        weatherEnv: new Map(),         // 环境介质/时段（天气影调判据）
      };
      const extraArrUnion = new Map<string, number>(); // secondarySubjects 并集（值 → 出现帧数）

      /** 将一段 VLM 帧加入时间窗聚合（引用计数 +1，首次出现时写入顺序表） */
      const addFrameToWindow = (f: typeof sortedDescs[number]) => {
        const d = f.description;
        if (d) {
          const prev = descCounts.get(d) || 0;
          if (prev === 0) descOrder.push(d);
          descCounts.set(d, prev + 1);
        }
        const emo = (f.emotion || '').trim();
        if (emo) emotionCounts.set(emo, (emotionCounts.get(emo) || 0) + 1);
        const st = (f.shotType || '').trim();
        if (st) shotTypeCounts.set(st, (shotTypeCounts.get(st) || 0) + 1);
        const cm = (f.cameraMovement || '').trim();
        if (cm) cameraMovementCounts.set(cm, (cameraMovementCounts.get(cm) || 0) + 1);
        const sn = (f.scene || '').trim();
        if (sn) sceneCounts.set(sn, (sceneCounts.get(sn) || 0) + 1);
        for (const r of (f.characters || [])) {
          if (typeof r === 'string' && r.trim()) {
            const key = r.trim();
            roleCounts.set(key, (roleCounts.get(key) || 0) + 1);
          }
        }
        for (const k of Object.keys(extraStrCounts)) {
          const v = String((f as any)[k] || '').trim();
          if (v) {
            const m = extraStrCounts[k];
            m.set(v, (m.get(v) || 0) + 1);
          }
        }
        for (const s of ((f as any).secondarySubjects || [])) {
          if (typeof s === 'string' && s.trim()) {
            const key = s.trim();
            extraArrUnion.set(key, (extraArrUnion.get(key) || 0) + 1);
          }
        }
      };

      /** 将一段 VLM 帧从时间窗聚合中移除（引用计数 -1，归零后删除） */
      const removeFrameFromWindow = (f: typeof sortedDescs[number]) => {
        const d = f.description;
        if (d) {
          const prev = descCounts.get(d) || 0;
          if (prev <= 1) {
            descCounts.delete(d);
            const idx = descOrder.indexOf(d);
            if (idx >= 0) descOrder.splice(idx, 1);
          } else {
            descCounts.set(d, prev - 1);
          }
        }
        const emo = (f.emotion || '').trim();
        if (emo) {
          const c = (emotionCounts.get(emo) || 0) - 1;
          if (c <= 0) emotionCounts.delete(emo); else emotionCounts.set(emo, c);
        }
        const st = (f.shotType || '').trim();
        if (st) {
          const c = (shotTypeCounts.get(st) || 0) - 1;
          if (c <= 0) shotTypeCounts.delete(st); else shotTypeCounts.set(st, c);
        }
        const cm = (f.cameraMovement || '').trim();
        if (cm) {
          const c = (cameraMovementCounts.get(cm) || 0) - 1;
          if (c <= 0) cameraMovementCounts.delete(cm); else cameraMovementCounts.set(cm, c);
        }
        const sn = (f.scene || '').trim();
        if (sn) {
          const c = (sceneCounts.get(sn) || 0) - 1;
          if (c <= 0) sceneCounts.delete(sn); else sceneCounts.set(sn, c);
        }
        for (const r of (f.characters || [])) {
          if (typeof r === 'string' && r.trim()) {
            const key = r.trim();
            const c = (roleCounts.get(key) || 0) - 1;
            if (c <= 0) roleCounts.delete(key); else roleCounts.set(key, c);
          }
        }
        for (const k of Object.keys(extraStrCounts)) {
          const v = String((f as any)[k] || '').trim();
          if (v) {
            const m = extraStrCounts[k];
            const c = (m.get(v) || 0) - 1;
            if (c <= 0) m.delete(v); else m.set(v, c);
          }
        }
        for (const s of ((f as any).secondarySubjects || [])) {
          if (typeof s === 'string' && s.trim()) {
            const key = s.trim();
            const c = (extraArrUnion.get(key) || 0) - 1;
            if (c <= 0) extraArrUnion.delete(key); else extraArrUnion.set(key, c);
          }
        }
      };

      let winLeft = 0; // sortedDescs[winLeft..winRight-1] 属于当前 chunk 的 [start-500, end+500] 窗口
      let winRight = 0;

      for (const chunk of chunks) {
        const start = Number(chunk.startMs) || 0;
        const end = Number(chunk.endMs) || start;
        const winStart = start - 500;
        const winEnd = end + 500;

        // 滑出左边界的帧移除：timeMs < winStart 的帧出窗
        while (winLeft < winRight && sortedDescs[winLeft].timeMs < winStart) {
          removeFrameFromWindow(sortedDescs[winLeft]);
          winLeft++;
        }
        // 加入新右边界的帧：timeMs <= winEnd && timeMs >= winStart 的帧入窗
        while (winRight < sortedDescs.length && sortedDescs[winRight].timeMs <= winEnd) {
          if (sortedDescs[winRight].timeMs >= winStart) {
            addFrameToWindow(sortedDescs[winRight]);
          }
          winRight++;
        }

        // 🎯 描述"去稀释"：descOrder 已按"文本精确去重+首现序"维护，但同一物理镜头内
        //  不同帧描述各不相同，全部拼接会无限冗长——喂给中文 CLIP 时要么超长截断把
        //  关键道具/动作推到末尾丢掉，要么被边缘一闪的帧噪声稀释主流画面语义。
        //  改进：按帧内出现频次降序（高频=主流画面置前），并限制拼接条数上限，
        //  保证切片描述始终聚焦主画面 + 关键信息，不被低频瞬态帧淹没。
        if (descOrder.length > 0) {
          const sortedDescs = [...descOrder].sort(
            (a, b) => (descCounts.get(b) || 0) - (descCounts.get(a) || 0),
          );
          chunk.description = sortedDescs.slice(0, MAX_AGGREGATED_DESC_SEGS).join('；');
        }
        if (emotionCounts.size > 0) {
          chunk.emotion = [...emotionCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        }
        if (shotTypeCounts.size > 0) {
          chunk.shotType = [...shotTypeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        }
        if (cameraMovementCounts.size > 0) {
          chunk.cameraMovement = [...cameraMovementCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        }
        /** 🎬 批1 场景众数（N1）：帧级场景值（desc「场景:」回捞）按引用计数取众数落 chunk.scene；
         *  chunk.scene 再经 daemon _map_scene_group 映射成组，供 KM 场景命中加成/窗口豁免。 */
        if (sceneCounts.size > 0) {
          chunk.scene = [...sceneCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        }
        if (roleCounts.size > 0) chunk.characters = [...roleCounts.keys()];
        // 🎬 第2步（2026-09-16）：7 个结构化字段落到切片——字符串取众数，数组取并集。
        //   这些字段此前**从未进入切片**（metadata.videoChunks 里连键都不存在），
        //   是导演(shotStyle/primarySubject)、编剧(dramaticConflict)、美术(spatialRelation/visualAtmosphere)
        //   四个视听维度的唯一数据源，落库后才谈得上被步骤5 打分消费。
        for (const k of Object.keys(extraStrCounts)) {
          const m = extraStrCounts[k];
          if (m.size > 0) (chunk as any)[k] = [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
        }
        if (extraArrUnion.size > 0) chunk.secondarySubjects = [...extraArrUnion.keys()];
        /** 🔧 Phase 0 终极兜底（聚合级，对老数据也生效）：
         *  若经过 frames 聚合后，chunk.shotType/emotion/characters 还是空（典型 8月12日项目诊断），
         *  但 chunk.description 里已经聚合了帧级自然语言描述（含【中景】/主体:/情绪: 前缀），
         *  我们再调用一次正则回捞填补 chunk 顶层字段。这一层兜底的意义：
         *   1. 老项目的 frameDescriptions 是旧格式（没有 downstream），帧聚合阶段取不到结构化字段，
         *      但 description 聚合文本里仍然保留了这些信息，可以从这里再解析一次。
         *   2. 即使是新项目，VLM 在某几帧连续漏写 downstream 字段时，聚合后仍可能是缺字段。 */
        if (chunk.description && String(chunk.description).trim()) {
          VisionExtractStrategy.fillStructuredFromDescription(chunk, chunk.description);
        }
      }
      const withDesc = chunks.filter((c) => (c.description || '').trim().length > 0).length;
      const withEmotion = chunks.filter((c) => (c.emotion || '').trim().length > 0).length;
      const withShotType = chunks.filter((c) => (c.shotType || '').trim().length > 0).length;
      const withCameraMovement = chunks.filter((c) => (c.cameraMovement || '').trim().length > 0).length;
      const withScene = chunks.filter((c) => (c.scene || '').trim().length > 0).length;
      const withCharacters = chunks.filter((c) => Array.isArray(c.characters) && c.characters.length > 0).length;
      const withKeywords = chunks.filter((c) => Array.isArray(c.keywords) && c.keywords.length > 0).length;
      // 🔬 第2步诊断（2026-09-16）：直接判定"结构化字段长期归零"的结构断层在哪一层——
      //   ① 下游帧是否带 downstream（缺失则所有只依赖 downstream 的字段必然静默归零）；
      //   ② 映射后运镜是否可用（补了描述回捞后应显著 >0）；
      //   ③ 7 个新字段的切片覆盖率。三者并列，一眼定位断点。
      const _rawFrames = collectFrameDescriptions(task);
      const _framesWithDownstream = _rawFrames.filter((f: any) => f && typeof f.downstream === 'object' && f.downstream !== null).length;
      /** 🎬 §20 第1步：原生 scene 可用帧数（应≈帧数；远小于则仍退回正则回捞口径） */
      const _framesWithNativeScene = _rawFrames.filter((f: any) => String(f?.downstream?.scene || '').trim()).length;
      const _framesCamUsable = frameDescs.filter((f: any) => String(f.cameraMovement || '').trim()).length;
      const _withNew = (k: string) => chunks.filter((c: any) => String(c[k] || '').trim().length > 0).length;
      AppLogger.info(LOG_TAGS.AI_AGENT,
        `[镜头匹配] 🎬 结构化字段落库（第2步）：帧=${_rawFrames.length} 带downstream=${_framesWithDownstream} `
        + `原生scene帧=${_framesWithNativeScene} 运镜可用帧=${_framesCamUsable} | 切片覆盖：shotStyle=${_withNew('shotStyle')} `
        + `dramaticConflict=${_withNew('dramaticConflict')} spatialRelation=${_withNew('spatialRelation')} `
        + `visualAtmosphere=${_withNew('visualAtmosphere')} primarySubject=${_withNew('primarySubject')} `
        + `interaction=${_withNew('interaction')} cameraMovement=${_withNew('cameraMovement')} `
        + `secondarySubjects=${chunks.filter((c: any) => Array.isArray(c.secondarySubjects) && c.secondarySubjects.length > 0).length} `
        // 🎬 §20 第4步：新增三字段落库覆盖（均为 0 说明 v5 prompt 未生效 → 检查 PROMPT_VERSION / 是否真重跑）
        + `keyProps=${_withNew('keyProps')} costume=${_withNew('costume')} weatherEnv=${_withNew('weatherEnv')}`);
      AppLogger.info(LOG_TAGS.AI_AGENT,
        `[镜头匹配] 帧描述聚合完成（含 Phase 0 结构化回捞）：` +
        `${withDesc}/${chunks.length} 带画面描述，` +
        `${withEmotion}/${chunks.length} 带情绪，` +
        `${withShotType}/${chunks.length} 带景别shotType，` +
        `${withCameraMovement}/${chunks.length} 带运镜cameraMovement，` +
        `${withScene}/${chunks.length} 带场景scene，` +
        `${withCharacters}/${chunks.length} 带角色characters，` +
        `${withKeywords}/${chunks.length} 带关键词keywords`);
      /** 🎬 阶段 B：把镜头级语义字段 inherit 到匹配候选级 matchSegments。
       *  matchSegments 是 Python 侧按 3s 拆出的候选段（无独立 VLM 帧聚合），
       *  它们的 description/emotion/shotType/scene/keywords 继承自所属物理镜头的聚合结果，
       *  保证 KM 的"文案↔候选段"匹配与"文案↔镜头"匹配共享同一套语义口径。
       *  🎭 例外（2026-09-18）：**characters 不继承**——切片级 characters 必须逐帧口径
       *  （只取覆盖本切片时间窗的帧），父镜头/场次全体出场人物另存 `charactersSceneLevel`，
       *  否则「飞机在空中飞」的全景切片会挂着父镜头 12 个 characters（含 绿植/窗外路灯/三人围坐沙发）。 */
      if (matchSegments.length > 0) {
        /** 镜头级 chunks 的 id 形如 chunk_003、parentChunkId 形如 scene_003，需按 parentChunkId 建索引，
         *  候选段 seg.parentChunkId 才能命中其所属物理镜头。 */
        const chunkById = new Map<string, any>();
        for (const c of chunks) chunkById.set(String(c.parentChunkId || c.id), c);
        for (const seg of matchSegments) {
          const parent = chunkById.get(String(seg.parentChunkId));
          if (!parent) continue;
          if (parent.description) seg.description = parent.description;
          if (parent.emotion) seg.emotion = parent.emotion;
          if (parent.shotType) seg.shotType = parent.shotType;
          if (parent.cameraMovement) seg.cameraMovement = parent.cameraMovement;
          if (parent.scene) seg.scene = parent.scene;
          /** 🎭 切片级 characters：**逐帧口径**——只取覆盖本切片时间窗 [startMs, endMs] 的帧。
           *  取不到（无覆盖帧/帧内无人物）时显式清除，防止父镜头并集（或兜底重建的展开残留）漏网。 */
          const segStartMs = Number(seg.startMs) || 0;
          const segEndMs = Number(seg.endMs) || segStartMs;
          const segCharacters = SemanticAnalyzeStrategy.collectCharactersCoveringWindow(sortedDescs, segStartMs, segEndMs);
          if (segCharacters && segCharacters.length > 0) seg.characters = segCharacters;
          else delete seg.characters;
          /** 🎭 整段/父镜头全体出场人物：另存新字段（软数据源），不再污染切片级 characters */
          if (Array.isArray(parent.characters) && parent.characters.length > 0) {
            seg.charactersSceneLevel = parent.characters;
          }
          if (Array.isArray(parent.keywords) && parent.keywords.length > 0) seg.keywords = parent.keywords;
        }
      }
    }
    /** 🎬 批1 场景补齐（N1，无条件执行）：上述帧聚合仅在"本批有帧描述"时运行——
     *  命中 DB 缓存 / ownPool 复用且任务无帧时 chunk.scene 仍可能缺，这里统一补最后一层：
     *  ① chunk 缺 scene → 从 chunk.description「场景:」正则回捞；
     *  ② matchSegments 缺 scene → 先继承所属父镜头的 chunk.scene，仍缺再自身 desc 回捞。
     *  保证送入 KM / preselect 的候选段恒携带 scene 字段（无描述/无场景词的段保持空，中性不加不减）。 */
    {
      const chunkByParentId = new Map<string, any>();
      for (const c of chunks) chunkByParentId.set(String(c.parentChunkId || c.id), c);
      for (const c of chunks) {
        if (!(c.scene || '').trim()) {
          const s = extractSceneFromDescription(c.description);
          if (s) c.scene = s;
        }
      }
      for (const seg of matchSegments) {
        if ((seg.scene || '').trim()) continue;
        const parent = chunkByParentId.get(String(seg.parentChunkId));
        if (parent && (parent.scene || '').trim()) {
          seg.scene = parent.scene;
        } else {
          const s = extractSceneFromDescription(seg.description);
          if (s) seg.scene = s;
        }
      }
    }

    /** 🎭 人物归一（2026-09-18）：把镜头级 chunks 与匹配候选段 matchSegments 的**字面角色名**
     *  （characters）统一映射为注册表主键 charIds，并落一个粒度标记 charGrain。
     *  - 消费方：daemon role_score / 主角特写路由改比 charIds 交集 → 同一角色的
     *    "宋慧乔 / 宋慧乔饰演的角色 / 女子（宋慧乔）" 等多种写法不再各算各的；
     *  - 只在**存在注册表**时才写入 charIds（无注册表 = 不归一，daemon 侧回退旧 characters 行为，零行为变化）；
     *  - charGrain：characters 条数 > 3 → union_suspect（疑似父镜头并集回填），daemon 对该切片角色贡献降权；
     *  - 🛑 用户级铁律（粒度不可信）：人物**只能作软排信号**，任何时候不得作硬门禁（不得出现 5.0 级惩罚）——
     *    切片 characters 由 VLM 帧聚合而来，并集回填污染客观存在，误识别一旦当门禁就会否决正确切片。 */
    {
      const personAliasTable = loadPersonAliasTable(projectId);
      if (personAliasTable.length > 0) {
        let segCharIdsCount = 0;
        let segUnionSuspect = 0;
        for (const c of chunks) {
          const norm = normalizeCharactersToCharIds(c.characters, personAliasTable);
          if (norm.charIds.length > 0) c.charIds = norm.charIds;
          else delete c.charIds;
          c.charGrain = norm.charGrain;
        }
        for (const seg of matchSegments) {
          const norm = normalizeCharactersToCharIds(seg.characters, personAliasTable);
          if (norm.charIds.length > 0) seg.charIds = norm.charIds;
          else delete seg.charIds;
          seg.charGrain = norm.charGrain;
          if (norm.charIds.length > 0) segCharIdsCount++;
          if (norm.charGrain === 'union_suspect') segUnionSuspect++;
        }
        AppLogger.info(LOG_TAGS.AI_AGENT,
          `[镜头匹配] 🎭 人物归一完成：别名表 ${personAliasTable.length} 条｜候选段带 charIds ${segCharIdsCount}/${matchSegments.length}｜union_suspect ${segUnionSuspect} 段`);
      }
    }

    /** 🛠 P0 修复（描述落库缺失）：上方帧描述聚合把 description/emotion/shotType/characters/scene
     *  写进了**内存** chunks/matchSegments，但首次落库发生在聚合之前（见上方 daemon detect 后的
     *  videoRepo.save），此后仅"daemon 回传 clipZhEmbedding"那条路径（下方 P2 缓存落库）会二次写库。
     *  实测后果：daemon 命中素材池缓存的项目（如 26年9月8日/浪漫满屋），DB 中 segs.description
     *  覆盖率仅 0.2% —— 导致替换弹窗候选检索（SliceSearchService 读 DB matchSegments 做 TF-IDF）
     *  无文本可用而完全失效，且下次命中 DB 缓存时匹配退化为纯图像语义。
     *  这里在「聚合 + 场景补齐」之后**无条件回写一次**，保证 DB 与内存口径一致。 */
    if (chunks.length > 0) {
      try {
        // 与上方首次落库同一封面安全门禁：仅固化携带 Python 独立封面（seg_*）的候选段
        const segsEnriched = matchSegmentsHaveOwnCovers(matchSegments) ? matchSegments : [];
        if (!needTrim) videoRepo.save(rawCacheKey, chunks, segsEnriched);
        if (needTrim) videoRepo.save(trimAwareCacheKey, chunks, segsEnriched);
        const withDesc = matchSegments.filter((s) => (s.description || '').trim().length > 0).length;
        AppLogger.info(LOG_TAGS.AI_AGENT,
          `[镜头匹配] 🛠 聚合后回写切片缓存：chunks=${chunks.length} segs=${matchSegments.length}（带描述 ${withDesc}）`);
      } catch (e: any) {
        AppLogger.warn(LOG_TAGS.AI_AGENT, `[镜头匹配] 聚合后回写切片缓存失败: ${e.message}`);
      }
    }

    /** 步骤3：构建 KM 匹配请求 */
    onProgress(40, `正在匹配 ${scriptShots.length} 段文案与画面...`);
    /**
     * 构造带音频时长 + 多维字段（情绪/角色/画面意图/时间锚/原声标记）的 query 列表，
     * 复用共享纯函数 buildMatchQueries（避免 AIService 与本策略的 query 构造漂移）。
     */
    /** 🔧 模式 A（2026-09-05）：全链路恒【源坐标】，query.startMs/audioSource 不再转 body，第三参固定 0 */
    const allQueries = SemanticAnalyzeStrategy.buildMatchQueries(scriptShots, ttsDurations, 0, projectId,
      /** 🔒 B域（§10.2.3 动作2）：锁1 位置校正透传媒体物理坐标（trimStartMs/sourceDurationMs）。 */
      { trimStartMs: trim.trimStartMs, srcDurationMs: trim.srcDurationMs },
      /** 步骤1 ③ 气口：透传 ASR 时间轴（含 silenceGapMs），供原声段 query 注入句尾静音气口（补丁2/7 消费）。 */
      asrLines);

    /** 🎬 S3 正式 cutover：把 `ZENTECT_KM_STORYBOARD_MODE`（缺省 on）同步到 daemon 的 `temp/storyboard-mode` 标记文件。
     *  daemon `load_storyboard` 读标记文件，Node 作为正式 env 入口在此落盘，daemon 读取路径不变、零 Python 改动。 */
    syncStoryboardModeFile();

    /** 🎬 A1·S2 分镜师 Agent（§24.16-A，规格 §5.2）：`ZENTECT_STORYBOARD_OPEN=on` 时为每个母句开 α 真工单
     *  ShotSpec，并按 matchUnitId 把 `segmentId/spatialType/shotMode/fallbackLevel` 4 字段回填到 query，
     *  随请求体 queries[i] 透传 daemon（KMMatchQuery 已支持读入）。off 档整段旁路（P1）：
     *  不调用 Agent、不写任何工单字段，query 字段集与线上逐字节一致（含不追加字段）。 */
    if (resolveStoryboardOpen()) {
      /** 开单失败/空工单绝不卡死步骤5：warn 并回退既有链路（规格 §8-5）；但一旦产出即生效（α 真工单） */
      const orders = await StoryboardAgent.openOrders(allQueries, projectId, {
        batchSize: Number(process.env.ZENTECT_STORYBOARD_BATCH) > 0
          ? Number(process.env.ZENTECT_STORYBOARD_BATCH)
          : undefined,
      });
      if (orders && orders.length > 0) {
        const ordersByUnit = new Map<string, ShotSpec>();
        for (const spec of orders) ordersByUnit.set(String(spec.matchUnitId), spec);
        let attached = 0;
        let noMatch = 0;
        for (const q of allQueries) {
          const key = String((q as any)?.matchUnitId || q.shotId || '');
          const spec = key ? ordersByUnit.get(key) : undefined;
          if (!spec) {
            noMatch++;
            continue;
          }
          // 🔗 接线点：仅 on 档且命中该 spec 时才写工单字段（P1：任何其它情况不写，legacy 产物零变化）
          (q as any).segmentId = spec.segmentId;
          (q as any).spatialType = spec.spatialType;
          (q as any).shotMode = spec.mode;
          (q as any).fallbackLevel = spec.fallbackLevel;
          attached++;
        }
        AppLogger.info(LOG_TAGS.AI_AGENT,
          `[镜头匹配][开单] α 真工单命中：${attached}/${allQueries.length}（未命中 ${noMatch}，缺失者回退既有链路字段）`);
      } else {
        AppLogger.warn(LOG_TAGS.AI_AGENT,
          '[镜头匹配][开单] 开单失败或空工单 → 回退既有链路（query 不写工单字段，P1 零影响）');
      }
    }

    /** 🎯 匹配单位折叠（2026-09-18，方案 §23.12）：sentence 档下 allQueries 已是"一个完整句一条"的单位级 query，
     *  但下游（matchResults / 流式卡片 / 字幕 / 导出）必须仍是段落粒度 ⇒ 这里保留一份【碎片级 query 视图】，
     *  出结果时按碎片自身 matchUnitId（既有 id 映射，不新建映射表）取回所属单位的命中结果并展开回全部碎片。
     *  legacy 档下 shotLevelQueries 与 allQueries 同一份引用 ⇒ 全链路零变化。 */
    const matchUnitMode = resolveScriptMatchUnitMode();
    const shotLevelQueries = matchUnitMode === 'sentence'
      ? SemanticAnalyzeStrategy._buildShotLevelQueries(scriptShots, ttsDurations, projectId)
      : allQueries;
    if (matchUnitMode === 'sentence') {
      AppLogger.info(LOG_TAGS.AI_AGENT,
        `[镜头匹配][匹配单位] sentence 档折叠：碎片 ${shotLevelQueries.length} 段 → 匹配单位 ${allQueries.length} 条 query` +
        `（每单位一条，结果按 matchUnitId 回填到全部碎片，matchResults 数量恒等于段落数）`);
    }

    /** 🔧 源窗诊断断言（2026-09-05 模式 A 防线 C）：needTrim 项目候选池坐标恒为【源坐标】，
     *  范围应落在正剧源窗 [trimStartMs, srcDurationMs−trimEndMs] 内（无 OP/ED/credits）。
     *  仅诊断日志，不改行为——异常形态（空池 / 起点落在 OP 区 / 越出 ED 起点）warn 暴露，杜绝脏池静默进 KM。 */
    if (needTrim) {
      let minS = Infinity, maxE = -Infinity;
      for (const s of matchSegments) {
        const a = Number(s?.startMs) || 0, b = Number(s?.endMs) || a;
        if (a < minS) minS = a;
        if (b > maxE) maxE = b;
      }
      const edStartSrc = (typeof trim.srcDurationMs === 'number' && trim.srcDurationMs > 0)
        ? Math.max(0, trim.srcDurationMs - trim.trimEndMs)
        : undefined;
      const nSegs = matchSegments.length;
      const suspicious = nSegs === 0
        || minS < -1 || maxE <= 0
        || minS < trim.trimStartMs - 5000
        || (edStartSrc !== undefined && maxE > edStartSrc + 5000);
      const diag = `[镜头匹配][源窗] segs=${nSegs} segStart∈[${nSegs ? minS : '-'}~${nSegs ? maxE : '-'}]ms 正剧源窗=[${trim.trimStartMs}~${edStartSrc !== undefined ? Math.round(edStartSrc) : '?'}]ms`;
      if (suspicious) {
        AppLogger.warn(LOG_TAGS.AI_AGENT, `${diag} ⚠️ 候选池不在正剧源窗（可能混入 OP/ED 或坐标未归一），请检查裁剪/还原路径`);
      } else {
        AppLogger.info(LOG_TAGS.AI_AGENT, `${diag} ✓`);
      }
    }

    /** 🎙️ 原声定位承载池 = 【清洗前】的完整源坐标切片池（2026-09-14 根因修复）：
     *  原声段按时间窗定位承载切片，与画面语义描述无关；而无信息/字卡剔除基于 desc 覆盖率，
     *  当历史数据 desc 覆盖率≈0 时（仅 1/605 带描述），hasSemanticSource=true 会触发整池误杀
     *  把承载切片一并砍掉（1613→4 即此例），导致原声定位 6/6 全落空。故原声定位必须绕开清洗后池。
     *  该池已过 trim/源坐标换算（看上方 源窗诊断 ✓），与 query 的 startMs/audioSource 同坐标系。 */
    const originalMatchPool = matchSegments;

    /** 🎬 无信息帧剔除（2026-09-04 观察项 1.3；2026-09-05 修正"候选 884→0"）：
     *  剔除必须建立在"候选池确实携带可判语义描述"之上：
     *   - 池内存在带描述/关键词段（聚合数据有效）→ desc 与 keywords 全空的段才是真无信息帧
     *     （黑场/纯字幕/转场，VLM 看过却无可描述内容），剔除；命中字卡的文本段（desc 非空）剔除；
     *   - 池内 desc 覆盖率 0（本次无帧描述聚合数据，缓存/产物本身不带 desc）→ 无法区分"无信息帧"
     *     与"正常画面帧"，不得整池误杀，保留全池交 KM 图像语义裁决（宁留黑场也不空手匹配）。
     *  避免"介绍人物/字幕画面"被解说词匹配中的目标由「desc 可判」路径承担，另一路径不再清空候选池。 */
    {
      /** 🔧 2026-09-14 事故修复：清洗判定从".some(存在1段带描述)"升级为"desc 覆盖率 ≥ 阈值才采信清洗"。
       *  some() 过敏感——旧项目 desc 覆盖率仅 1/605≈0.16% 也会触发整池清洗把 1613→4 误杀，
       *  直接导致 KM 语义匹配候选枯竭、普通文案段大面积空白卡片（原声段虽改用原始池但 KM 段仍挨饿）。
       *  覆盖率过低（含 0）时无法可靠区分"黑场/字幕无信息帧"与"正常画面帧"，一律保留全池
       *  交 KM 图像语义裁决（宁留黑场也不误杀候选），覆盖率达标才做无信息剔除。 */
      const totalSegs = matchSegments.length;
      let withSemanticCount = 0;
      for (const s of matchSegments) {
        const desc = String(s?.description || '').trim();
        const hasKw = Array.isArray(s?.keywords) ? s.keywords.length > 0 : !!s?.keywords;
        if (desc || hasKw) withSemanticCount++;
      }
      const descCoverage = totalSegs > 0 ? withSemanticCount / totalSegs : 0;
      const canTrustClean = descCoverage >= 0.3; // 覆盖率 ≥ 30% 才认为池内语义描述可信、可做无信息剔除
      if (!canTrustClean) {
        if (totalSegs > 0) {
          AppLogger.info(LOG_TAGS.AI_AGENT,
            `[镜头匹配] 候选池语义描述覆盖率过低(${withSemanticCount}/${totalSegs}=${(descCoverage * 100).toFixed(1)}%)，跳过空描述剔除，保留 ${totalSegs} 段走 KM 图像语义`);
        }
      } else {
        const { kept, dropped } = stripUninformativeMatchSegments(matchSegments);
        if (dropped > 0) {
          AppLogger.info(LOG_TAGS.AI_AGENT,
            `[镜头匹配] 无信息/字卡候选剔除 ${dropped} 段（字幕卡/黑场/空描述），候选 ${matchSegments.length}→${kept.length}`);
        }
        matchSegments = kept;
      }
    }

    /** 🔧 P2.0 碎片 seg 前置清洗（KM 与原声定位共用同一清洗后池）：合并 <500ms 碎片到相邻 seg，
     *  从源头降低变速超限触发概率（碎片单段天然时长不足，是重选常客）。运行时清洗，不落库。 */
    SemanticAnalyzeStrategy.mergeFragmentSegments(matchSegments);

    /** 🎙️ 原声段落预匹配：按【时间窗】定位原片切片（命中的段落不送 KM，未命中回退语义匹配）
     *  🔧 P1 #7 + 2026-09-14：用 promisePool（并发 8）并行化；统一按源坐标时间窗锁定切片，零文本匹配。
     *  🎬 坐标系契约（2026-09-05 模式 A）：query.startMs/audioSource 与 matchSegments 均【源坐标】——两端同参照，无需换算。 */
    const originalMatches = new Map<string, any>();
    const originalQueries = allQueries.filter((q) => q.keepOriginalAudio);
    if (originalQueries.length > 0) {
      const locResults = await promisePool(
        originalQueries.map((q) => () => Promise.resolve().then(() => {
          /** 🎙️ 原声段统一按【时间窗】定位切片（源坐标，与步骤3 同一口径，零文本匹配）：
           *  首选 audioSource（步骤3 已收敛，更紧凑）；缺失时直接用段落画面窗 q.startMs/durationMs。
           *  切片承载：全覆盖 → ±500ms 收缩 → 最大重叠（台词/画面窗跨切片边界时最近切片承接）；
           *  timeline 恒为原声精确窗口，切片仅作承载，不压缩音频。 */
          const winStart = (typeof q.audioSourceStartMs === 'number' ? q.audioSourceStartMs : Number(q.startMs) || 0);
          const winEnd = (typeof q.audioSourceEndMs === 'number'
            ? q.audioSourceEndMs
            : (Number(q.startMs) || 0) + (Number(q.durationMs) || 0));
          let loc: ReturnType<typeof SemanticAnalyzeStrategy.locateOriginalClip> = null;
          const chunk = SemanticAnalyzeStrategy.findCoveringChunk(originalMatchPool, winStart, winEnd, 0)
            || SemanticAnalyzeStrategy.findCoveringChunk(originalMatchPool, winStart + 500, winEnd - 500, 0)
            || SemanticAnalyzeStrategy.findMaxOverlapChunk(originalMatchPool, winStart, winEnd);
          if (chunk) {
            loc = {
              chunkId: chunk.id || '',
              coverPath: chunk.coverPath || '',
              chunkData: chunk,
              audioDurationMs: Math.max(0, winEnd - winStart),
              videoTimelineStartMs: winStart,
              videoTimelineEndMs: winEnd,
            };
          }
          return { shotId: q.shotId, query: q, loc };
        })),
        8,
      );
      for (const r of locResults) {
        if (r.loc) {
          originalMatches.set(r.shotId, { ...r.query, ...r.loc });
          AppLogger.info(
            LOG_TAGS.AI_AGENT,
            `[镜头匹配] 原声段落 ${r.shotId} 定位原片 ${r.loc.videoTimelineStartMs}~${r.loc.videoTimelineEndMs}ms → 切片 ${r.loc.chunkId}`,
          );
        } else {
          // 🔧 2026-09-14 原声定位失败诊断（warn 级，避免 debug 被日志级别过滤）：回显文本/锚点/切片池规模以定位根因
          const fq = r.query as any;
          const fbText = String((fq?.text ?? '') || '').split('|')[0].replace(/\s+/g, ' ').slice(0, 44);
          const _s = Number(fq?.startMs) || 0;
          const _d = Number(fq?.durationMs) || 0;
          const _ws = typeof fq?.audioSourceStartMs === 'number' ? fq.audioSourceStartMs : _s;
          const _we = typeof fq?.audioSourceEndMs === 'number' ? fq.audioSourceEndMs : _s + _d;
          AppLogger.warn(
            LOG_TAGS.AI_AGENT,
            `[镜头匹配] 原声段落 ${r.shotId} 未定位(audioSource=${typeof fq?.audioSourceStartMs === 'number'}, q窗=${Math.round(_s)}~${Math.round(_s + _d)}ms, 定位窗=${Math.round(_ws)}~${Math.round(_we)}ms, 原始池=${Array.isArray(originalMatchPool) ? originalMatchPool.length : 0}, 清洗后池=${Array.isArray(matchSegments) ? matchSegments.length : 0}, asrLines=${Array.isArray(asrLines) ? asrLines.length : 0}) 「${fbText}」 回退语义匹配`,
          );
        }
      }
    }
    /** 送 KM 的查询：排除已命中原声段落，避免其干扰全局求解 */
    const kmQueries = allQueries.filter((q) => !(q.keepOriginalAudio && originalMatches.has(q.shotId)));

    /** 🎯 回填索引（仅 sentence 档构建）：匹配单位 id → 该单位覆盖的碎片级 query。
     *  直接复用 collapseShotsToMatchUnits 的既有 id 映射（碎片 matchUnitId → 单位），不新建任何 id 规则/映射表；
     *  legacy 档不构建（流式卡片与结果回填都退回碎片自身，行为与现状一致）。 */
    const shotQueriesByUnitId = new Map<string, any[]>();
    if (matchUnitMode === 'sentence') {
      for (const g of collapseShotsToMatchUnits(shotLevelQueries)) shotQueriesByUnitId.set(String(g.matchUnitId), g.shots);
    }
    /** 🔧 设计 §4.2 对齐（L1 进度段）：原声定位完成锚点 40，为 KM 主循环留出 [40,80] 40 个节点内进度点（耗时占比最大阶段） */
    onProgress(40, '原声段落定位完成，正在筛选语义匹配候选...');

    if (kmQueries.length === 0) {
      /** 全部段落都是已命中的原声段落：直接组装结果，无需 KM */
      onProgress(100, '原声段落定位完成（无语义匹配段落）');
      const matches = allQueries.map((q) => SemanticAnalyzeStrategy.buildMatchResult(q, originalMatches.get(q.shotId), true));
      return {
        matches,
        segments: [],
        videoChunks: chunks,
        matchSegments,
        bgmBeats,
        originalMatchedCount: originalMatches.size,
        /** 🔧 匹配诊断：全部原声已定位直出（无语义匹配段落），无警告时为空数组 */
        diagnostics: buildMatchStepDiagnostics({
          matches, chunks, matchSegments,
          originalQueryCount: originalQueries.length,
          originalMatchedCount: originalMatches.size,
        }),
      };
    }

    /** 🃏 步骤5 卡片流式：原声段落定位完成即作为首批卡片先推一次。
     *   KM 是数分钟长任务，原声段不参与 KM（已定位原片窗口），
     *   先让前端渲染出这批"原声保留"卡片，再逐块补语义匹配卡片；
     *   最终全量返回由 mapPipelineResultToState 覆写收敛，流式仅即时渲染。 */
    if (originalMatches.size > 0) {
      const originalPartial = allQueries
        .filter((q) => originalMatches.has(q.shotId))
        .map((q) => SemanticAnalyzeStrategy.buildMatchResult(q, originalMatches.get(q.shotId), true));
      if (originalPartial.length > 0) {
        console.log('[STEP5-STREAM-main] 原声首卡推送', originalPartial.length, '张');
        onProgress(40, '原声段落定位完成，正在筛选语义匹配候选...', { partialMatches: originalPartial });
      }
    }

    /** 🔧 P2 #11 方案 A：KM Top-K 预选（Node 侧整体收窄 videoChunks，不改 daemon 契约）。
     *   仅在"送 KM 的查询子集"上执行预选，避免原声段落导致 query 池与 chunk 池尺度不一致。 */
    const preselect = SemanticAnalyzeStrategy.preselectTopK(kmQueries, matchSegments, {
      logProjectId: _context.projectId ? `[${_context.projectId}]` : '',
    });
    /** 记住原始匹配候选段，用于 matches→segment 回填（chunkData 里完整原始字段） */
    const originalChunksById = new Map<string, any>();
    for (const c of matchSegments) originalChunksById.set(String(c.id), c);
    /** 用预选过滤后的 chunk 池跑 KM；audit 用 perQueryTopK 放在闭包内 */
    const kmVideoChunks = preselect.filteredChunks;
    const perQueryTopKForAudit = preselect.perQueryTopK;

    /** 步骤4：调用 KM 全局排他性匹配算法 */

    /** 🔑 获取 VLM 二次裁决凭据：对低置信度匹配，云端多模态 LLM 直接看候选封面图选最优。
     *  用户 LLM 通道模型不支持识图时，daemon 侧连续失败会自动熔断，不影响匹配结果。 */
    let vlmConfig: { apiKey: string; baseURL: string; model: string } | null = null;
    try {
      const vlm = LLMFactory.getEffectiveConfig('visual');
      if (vlm.apiKey && vlm.baseURL && vlm.model) {
        vlmConfig = { apiKey: vlm.apiKey, baseURL: vlm.baseURL, model: vlm.model };
      }
    } catch {
      // 未配置 LLM 凭据，VLM 重排不可用（低置信段保持 CLIP 匹配结果）
    }

    /** 🔧 R3 取消贯通（PR-1）：taskId 唯一标识本次 KM 请求；
     *  abort/超时时 AIDaemon 会通知 daemon /cancel/{taskId}，KM 求解循环提前退出；
     *  retries:0 —— KM 是幂等重算任务，超时重试只会让 1000×1000 矩阵再空烧数分钟，不再无条件重试。
     *  🔧 P1-5 超时修正：长视频（45 分钟电视剧）场景切片拆成 3s 子段后切片池可达 900+，
     *    daemon 中文 CLIP 分支需对全部候选切片重编码封面图（实测 ~0.44s/切片，950 段 ≈ 7 分钟），
     *    原 180s 超时导致 KM 必然超时 → 走 fallback 也失败 → matchResults 全空（"一个文案都匹配不到"）。
     *    放宽到 15 分钟：首次跑（无 clipZhEmbedding 缓存）能完成，二次跑命中缓存后显著加快。 */
    const kmTaskId = `${_context.projectId}-km-${Date.now()}`;
    /** 🔧 设计 §4.2 对齐（L1 进度段）：KM 真实进度轮询 [0,1] 映射到节点内 [40,80] 40 个点（占比最大阶段）。
     *   轮询 fire-and-forget，KM resolve/catch 时置 kmPollStopped 退出。前端 Math.max 单调保护，进度只增不减。 */
    onProgress(40, '正在调用匹配算法求解全局最优组合（长视频可能需要数分钟）...');
    let kmPollStopped = false;
    void (async () => {
      /** 🔧 设计 §4.2 对齐：pollBase=40 pollSpan=40 → daemon 进度 [0,1] 映射 UI [40,80]（原 60/20 只占 20 个点，严重压缩 KM 阶段体感时间） */
      const pollBase = 40;
      const pollSpan = 40; // daemon 相对进度 [0,1] → UI [40,80]（节点内 40 个点，耗时占比匹配真实长视频 KM）
      // 🔧 卡死刷屏修复：记录"上次已上报"的 UI 刻度与阶段，仅当实际变化才推送。
      //   旧实现每 500ms 无条件 onProgress → KM 长时间停在同一子阶段（如封面重编码 0.03→0.32 之间）
      //   时，前端 console 每 0.5s 刷一遍相同"开始求解全局最优组合..."。单调只增，不漏报真实进展。
      let lastUi = pollBase;
      let lastStage = '';
      const report = (ui: number, stage: string) => {
        const stageChanged = stage !== lastStage;
        const uiAdvanced = ui > lastUi;
        if (!stageChanged && !uiAdvanced) return; // 无变化则跳过，杜绝原地刷屏
        lastUi = ui;
        lastStage = stage;
        onProgress(ui, stage || '正在求解全局最优组合...');
      };
      /** 🃏 卡片流式：shotId → query 索引，把 daemon 逐块推回的新增结果转成前端 matchResult 形状 */
      const streamQueryById = new Map<string, any>();
      for (const q of kmQueries) streamQueryById.set(String(q.shotId), q);
      while (!kmPollStopped) {
        try {
          const km = await AIDaemon.getInstance().getKmProgress(kmTaskId);
          if (km && typeof km.progress === 'number') {
            const mapped = Math.max(lastUi, Math.min(pollBase + pollSpan, pollBase + km.progress * pollSpan));
            report(Math.round(mapped), km.stage || '正在求解全局最优组合...');
            /** 🃏 卡片流式：本批新增匹配结果 → buildMatchResult → 作为增量 partialMatches 推送，
             *  前端据此逐个渲染卡片。已定位原声段不参与 KM（不在 kmQueries）；定位失败兜底
             *  混入 KM 的原声段在此按 keepOriginalAudio 保真标记，避免流式卡片先丢标记、
             *  全量覆写时再闪变。 */
            if (Array.isArray(km.results) && km.results.length > 0) {
              console.log('[STEP5-STREAM-main] daemon 增量批', km.results.length, '| stage=', km.stage || '');
              /** 🎯 单位级结果 → 碎片级卡片（sentence 档）：一条单位结果展开为该完整句覆盖的每个碎片一张卡片，
               *  卡片 id/文本/时长仍取碎片自身（与最终全量结果同形，避免流式期出现单位 id 的过渡卡片）；
               *  legacy 档单位即单碎片，展开退化为原行为（一张结果一张卡片）。 */
              const partialMatches = km.results
                .flatMap((m: any) => {
                  const sid = String(m?.shotId || m?.mediaId || '');
                  const q = streamQueryById.get(sid);
                  if (!q) return [];
                  const withFullChunk = m.chunkData
                    ? m
                    : { ...m, chunkData: originalChunksById.get(String(m.chunkId || m.mediaId || '')) || null };
                  const fragments: any[] = shotQueriesByUnitId.get(sid) || [q];
                  return fragments
                    .map((fq: any) => {
                      const built = SemanticAnalyzeStrategy.buildMatchResultFromUnit(fq, withFullChunk);
                      if (!built) return null;
                      const fid = String(fq?.shotId || '');
                      return { ...built, id: built.id ? String(built.id) : fid, shotId: fid };
                    })
                    .filter(Boolean);
                });
              if (partialMatches.length > 0) {
                console.log('[STEP5-STREAM-main] 推送 partialMatches', partialMatches.length, '张');
                onProgress(mapped, km.stage || '正在求解全局最优组合...', { partialMatches });
              }
            }
          }
        } catch {
          // 单次轮询失败静默，下一循环继续（体验辅助路径，不影响主 KM 求解）
        }
        if (kmPollStopped) break;
        await new Promise(r => setTimeout(r, 500));
      }
    })();
    try {
      const kmResult = await AIDaemon.getInstance().post('/api/solver/kuhn_munkres_match', {
        /** 🔬 Step1 Layer1：为每个 query 附加段落级时间窗闭包（windowStartMs/windowEndMs），
         *  daemon 按此窗做硬边界过滤 + 候选不足自适应扩张，杜绝跨幕次跳变（决策 #1）。 */
        queries: kmQueries.map(SemanticAnalyzeStrategy.attachQueryWindow),
        videoChunks: kmVideoChunks,
        /** 🔧 缓存隔离：补传 projectId + mediaId，与 detect_scene_chunks 写入端同构的兜底 key（<projectId>:<mediaId>），
         *  daemon 素材池兜底命中本项目缓存，同项目复用、跨项目绝不串。 */
        projectId,
        mediaId: sceneMediaId,
        /** 🔧 P2 #11 方案B：行级候选白名单 { shotId: chunkId[] }，daemon 在代价矩阵里置强惩罚只让候选进 KM
         *   （方案A 已把 videoChunks 收窄成并集，方案B 再精确到每句候选，双层压缩；perQueryTopK 为空则 daemon 忽略） */
        candidateIds: preselect.perQueryTopK,
        bgmBeats,
        bpm: bgmBpm,
        weights: { sem: 0.62, emotion: 0.08, duration: 0.2, role: 0.1 },
        /** 🔍 VLM 二次裁决：低置信度匹配让云端多模态 LLM 直接看候选封面图选最优 */
        ...(vlmConfig ? {
          vlmApiKey: vlmConfig.apiKey,
          vlmApiBase: vlmConfig.baseURL,
          vlmApiModel: vlmConfig.model,
        } : {}),
      }, { timeout: 900000, retries: 0, taskId: kmTaskId });

      onProgress(80, '匹配完成，正在整理结果...');
      kmPollStopped = true; // KM 归一完成，结束进度轮询（后续 80→100 由 post-processing 接管）

      /** 🔧 诊断:KM 返回空 results 时打印 Node 侧边界计数,定位是"输入的锅"还是"KM 的锅"(纯诊断不改行为)。
       *  zero_dur 多 → KM 分块用 audioDurationMs 累计会聚簇;perQueryTopK 空集多 → 候选为空,KM 只能拿惩罚格/落失败。 */
      const kmResultsArr: any[] = (kmResult as any)?.results || (kmResult as any)?.data || [];
      if (kmResultsArr.length === 0) {
        const zeroDur = kmQueries.filter((q: any) => !q.audioDurationMs).length;
        const pk = preselect.perQueryTopK as Record<string, string[]> | undefined;
        const emptyPk = (pk ? Object.values(pk) : []).filter((ids) => !ids || ids.length === 0).length;
        AppLogger.warn(LOG_TAGS.AI_AGENT,
          `[镜头匹配][KM-DIAG] ★ KM 返回空 results: kmQueries=${kmQueries.length} | ` +
          `kmVideoChunks=${kmVideoChunks.length} | matchSegments=${matchSegments.length} | ` +
          `audioDurationMs=0 词数=${zeroDur} | perQueryTopK 空集=${emptyPk}/${(pk ? Object.keys(pk).length : 0)}`);
      }

      /** 🔧 P2 缓存落库：daemon 返回带 clipZhEmbedding 的切片子集，按 id 合并回写全量 matchSegments 并持久化，
       *  下次匹配命中 DB 缓存时免去中文 CLIP 图像重编码（性能优化，不改变匹配结果）。 */
      const kmChunks: any[] = (kmResult as any)?.videoChunks || [];
      if (kmChunks.length > 0) {
        const kmById = new Map<string, any>();
        for (const c of kmChunks) kmById.set(String(c.id), c);
        let merged = 0;
        for (const c of matchSegments) {
          const enriched = kmById.get(String(c.id));
          if (enriched && Array.isArray(enriched.clipZhEmbedding) && enriched.clipZhEmbedding.length > 0) {
            c.clipZhEmbedding = enriched.clipZhEmbedding;
            merged++;
          }
        }
        if (merged > 0) {
          try {
            // 🔧 2026-09-05：同样只固化携带 Python 独立封面的候选段，防兜底重建脏池随 embedding 一起落库
            new VideoChunkRepository().save(rawCacheKey, chunks,
              matchSegmentsHaveOwnCovers(matchSegments) ? matchSegments : []);
            AppLogger.info(LOG_TAGS.AI_AGENT, `[镜头匹配] clipZhEmbedding 缓存落库：${merged}/${matchSegments.length} 切片已回写 DB`);
          } catch (e: any) {
            AppLogger.warn(LOG_TAGS.AI_AGENT, `[镜头匹配] clipZhEmbedding 缓存落库失败: ${e.message}`);
          }
        }
      }

      /**
       * 将匹配结果转换为前端需要的格式（保持文案原始顺序；原声命中段优先取定位结果）。
       * 先把 matchData 转成 shotId→item 索引，回填 O(1)；旧实现 allQueries.map × matchData.find 的 O(N·M) 替代。
       * 🎯 结果回填（sentence 档）：这里始终按【碎片级】query 组装——KM 以匹配单位 id 返回，
       *   用碎片自身 matchUnitId（既有 id 映射，不新建映射表）取回所属单位的命中结果并展开到该单位全部碎片，
       *   ⇒ matchResults 数量恒等于段落数（legacy 档 matchUnitId 缺省 ⇒ unitKey 退化为碎片 id，与现状逐条等价）。
       */
      const matchData: any[] = kmResult?.results || kmResult?.data || [];
      const matchById = new Map<string, any>();
      for (const m of matchData) {
        const sid = (m as any)?.shotId;
        if (sid) matchById.set(String(sid), m);
      }
      const matches = shotLevelQueries.map((q) => {
        /** 匹配单位键：sentence 档 = 碎片所属完整句 id；legacy 档 = 碎片自身 id（同值，零变化） */
        const unitKey = String((q as any).matchUnitId || q.shotId);
        /** 原声段落：命中定位则直接用定位结果（原声段不参与断句，其单位键恒等于碎片自身 id） */
        const original = originalMatches.get(unitKey) || originalMatches.get(q.shotId);
        if (original) {
          return SemanticAnalyzeStrategy.buildMatchResult(q, original, true);
        }
        const matched = matchById.get(unitKey);
        if (matched) {
          /** 🔧 P2 #11：方案 A 中 daemon 拿到的是过滤后的 kmVideoChunks，chunkData 可能被裁剪；
           *   这里若 chunkData 缺失则补回 originalChunksById 的完整副本（保证下游 JianYing/Prima 导出不丢列）。 */
          const withFullChunk = matched.chunkData
            ? matched
            : { ...matched, chunkData: originalChunksById.get(String(matched.chunkId || matched.mediaId || '')) || null };
          /** 🎙️ 第三参透传：定位失败兜底混入 KM 的原声段，命中结果同样要保真原声标记
           *  （极端场景：窗口与全部切片零重叠时才会走到这里，timeline 取 KM 切片边界）。
           *  🎯 回填：碎片级文本/时长取碎片自身，画面归属（切片/timeline/置信度/变速）继承单位结果
           *  ⇒ 同一完整句的各碎片共享同一画面窗口，碎片数量与 id 形态均不变。 */
          return SemanticAnalyzeStrategy.buildMatchResultFromUnit(q, withFullChunk);
        }
        /** 未匹配到的段落 */
        return SemanticAnalyzeStrategy.buildMatchResult(q, null, q.keepOriginalAudio === true);
      });

      /** 📊 审计：KM 最终匹配 vs Top-K 预选集合。命中率 <0.95 打 warn，方便后续调 K。
       *  sentence 档 perQueryTopK 以匹配单位 id 为键 ⇒ 先把碎片级结果 id 归一为单位 id 再审计；
       *  legacy 档两者同值，直接透传（审计口径与现状一致）。 */
      SemanticAnalyzeStrategy.auditPreselectTopK(
        perQueryTopKForAudit,
        matchUnitMode === 'sentence'
          ? matches.map((m, i) => ({ ...m, id: String((shotLevelQueries[i] as any)?.matchUnitId || m.id || '') }))
          : matches,
        _context.projectId,
        /* 🎯 2026-09-19：传预选并集 id 全集，审计主指标对齐 daemon 豁免行为（chunk 在并集=未被预选删除）。
         *  双键都挂（id 与 media_id），与 matches 的 mediaId/chunkId 两个身份键对齐。 */
        kmVideoChunks.reduce<Set<string>>((acc, c) => {
          acc.add(String((c as any).id || ''));
          acc.add(String((c as any).media_id || (c as any).mediaId || ''));
          return acc;
        }, new Set()),
      );

      onProgress(100, '镜头匹配完成');
      return {
        matches,
        segments: matchData,
        videoChunks: chunks,
        matchSegments,
        bgmBeats,
        originalMatchedCount: originalMatches.size,
        /** 🔧 匹配诊断：切片池空 / KM 全未命中 / 原声定位失败 → 前端透出用户可读原因 */
        diagnostics: buildMatchStepDiagnostics({
          matches, chunks, matchSegments,
          originalQueryCount: originalQueries.length,
          originalMatchedCount: originalMatches.size,
        }),
      };
    } catch (e: any) {
      kmPollStopped = true; // 失败即终止进度轮询，避免泄漏
      /** 🛑 2026-09-05 B1：删除「KM 失败→回退 CLIP 帧匹配」降级路径。
       *  旧逻辑静默退成单帧匹配，产出 timeline=0 的假结果（预览从头/牛头不对马嘴的根源之一），
       *  根因被掩盖。按"错就错"原则：KM 求解异常直接 fail-fast 暴露给 UI（黄条/失败态），便于修复。 */
      AppLogger.error(LOG_TAGS.AI_AGENT, `[镜头匹配] KM 求解失败（已按 fail-fast 抛出，不再回退帧匹配）: ${e?.message || e}`, e);
      throw new Error(`镜头匹配失败（KM 求解异常）: ${e?.message || e}`);
    } finally {
      // 🔧 R1 模型生命周期（PR-1）：步骤5 匹配阶段结束（成功/失败/finally 兜底）后释放 daemon 常驻模型，
      //   clip/chinese_clip/face 不再跨项目常驻（Python 侧 KM finally 已释放，此处 Node 兜底）
      try {
        AIDaemon.getInstance().post('/release_models', {})
          .catch(() => { /* 释放失败静默，不影响主流程 */ });
      } catch { /* 静默 */ }
    }
  }

  /** 🎬 阶段 B 兜底：把镜头级 chunks 原地生成匹配候选级 matchSegments。
   *  适用：v1 老缓存（只有 chunks 数组）或旧版 daemon（未实现 matchSegments）时，
   *  按 3s 粒度对 >6s 的物理镜头拆分，短镜头原样保留；id 语义与 Python 侧一致（scene_xxx_segN），
   *  parentChunkId 指向物理镜头，天然供导出层 SAME_SCENE 识别与衔接判断。 */
  static buildMatchSegmentsFromChunks(chunks: any[]): any[] {
    const MAX_CHUNK_MS = 6000;
    const SEGMENT_MS = 3000;
    const segs: any[] = [];
    for (const c of chunks) {
      const start = Number(c.startMs) || 0;
      const end = Number(c.endMs) || start;
      const dur = end - start;
      const parentId = c.parentChunkId || c.id || 'chunk';
      const parentStart = c.parentStartMs != null ? c.parentStartMs : start;
      if (dur <= MAX_CHUNK_MS) {
        segs.push({
          ...c,
          id: `${parentId}_seg0`,
          parentChunkId: parentId,
          parentStartMs: parentStart,
          segmentIndexInParent: 0,
        });
        continue;
      }
      let cur = start, idx = 0;
      while (cur < end) {
        const segEnd = Math.min(end, cur + SEGMENT_MS);
        segs.push({
          ...c,
          /** 🎞️ 2026-09-05 封面错位根治：仅镜头首段（seg0）可继承镜头封面（镜头起点帧≈seg0 起点帧），
           *  非首段显式置空，不继承镜头封面——否则封面是镜头起点帧、预览从段起点（晚数秒）播，观感错位。 */
          coverPath: idx === 0 ? (c.coverPath || '') : '',
          id: `${parentId}_seg${idx}`,
          parentChunkId: parentId,
          parentStartMs: parentStart,
          segmentIndexInParent: idx,
          startMs: cur,
          endMs: segEnd,
          durationMs: segEnd - cur,
        });
        cur = segEnd;
        idx++;
      }
    }
    return segs;
  }

  /**
   * 🎭 切片级角色「逐帧口径」采集（2026-09-18 修复"父镜头并集回填"）：
   * 只取**覆盖该切片时间窗**的帧的 characters 并集，不继承父镜头/场次的整体并集。
   *
   * 背景（实测缺陷）：切片级 characters 原实现直接继承父镜头（chunk）的聚合并集，
   * 使「【全景】飞机在空中平稳飞行 场景:天空 主体:飞机」这类 3s 切片挂着父镜头全部
   * 12 个 characters（含 绿植/窗外路灯/三人围坐沙发 等道具布景）——人物表被布景污染。
   *
   * 覆盖定义：第 i 帧的覆盖区间 = [frames[i].timeMs, frames[i+1].timeMs)（末帧延伸到 +∞），
   * 与切片窗口 [startMs, endMs] 有交集即视为"覆盖该切片"。用覆盖区间而非"帧时间点落入窗口"，
   * 是因为切片仅 3s、抽帧间隔常 >3s，按点判定会让大量切片落空；按覆盖区间判定可保证
   * 每个切片都归属到确定的一帧/几帧，且不会把别的镜头的人拉进来。
   *
   * @param frames 帧列表（**必须按 timeMs 升序**，调用方传 sortedDescs）
   * @param startMs 切片起始时间（ms，须与 frames[].timeMs 同坐标系）
   * @param endMs 切片结束时间（ms）
   * @returns 去重后的切片级角色名数组；无覆盖帧或无人物时返回 undefined（错就错，不造假值）
   */
  static collectCharactersCoveringWindow(
    frames: { timeMs: number; characters?: string[] }[],
    startMs: number,
    endMs: number,
  ): string[] | undefined {
    if (!Array.isArray(frames) || frames.length === 0) return undefined;
    const set = new Set<string>();
    for (let i = 0; i < frames.length; i++) {
      const fStart = Number(frames[i]?.timeMs) || 0;
      /** 该帧的覆盖区间终点：下一帧时间；末帧延伸到 +∞（尾部切片仍归属最后一帧） */
      const fEnd = i + 1 < frames.length ? (Number(frames[i + 1]?.timeMs) || fStart) : Number.POSITIVE_INFINITY;
      if (fEnd <= startMs) continue; // 覆盖区间完全早于切片 → 跳过
      if (fStart >= endMs) break;    // 帧起点已晚于切片终点，后续帧更晚 → 提前结束
      const chars = frames[i]?.characters;
      if (Array.isArray(chars)) {
        for (const r of chars) {
          if (typeof r === 'string' && r.trim()) set.add(r.trim());
        }
      }
    }
    return set.size > 0 ? Array.from(set) : undefined;
  }

  /** 🔧 P2.0 碎片 seg 前置清洗：在 KM 预选与原声定位之前，将 <500ms 的碎片 seg 合并至相邻 seg（优先并入前段）。
   *   - 碎片是 matchSegments 在场景边界切分产生的（如 400ms/440ms 尾段），单段天然时长不足，是变速超限重选的常客；
   *   - 运行时数组原地清洗（merge 到相邻段并剔除碎片），不落库、不改 chunks_json 缓存契约，
   *     下游 locateOriginalClip / preselectTopK / KM 自然基于同一清洗后池；
   *   - 仅合并同 parentChunk 且物理连续（≤100ms 容差，与导出层 enrichMatchRelations 口径一致）的相邻 seg，不跨镜头合并；
   *   - 合并后父段 durationMs 累加，语义/封面继承父段，parentChunkId 语义不变。
   */
  static mergeFragmentSegments(segments: any[]): void {
    if (!Array.isArray(segments) || segments.length === 0) return;
    const FRAGMENT_MS = 500;
    const TIME_TOLERANCE_MS = 100;
    const byParent = new Map<string, any[]>();
    for (const s of segments) {
      const pid = s?.parentChunkId;
      if (typeof pid === 'string' && pid) {
        if (!byParent.has(pid)) byParent.set(pid, []);
        byParent.get(pid)!.push(s);
      }
    }
    const removed = new Set<any>();
    for (const siblings of byParent.values()) {
      siblings.sort((a, b) => (a?.segmentIndexInParent ?? 0) - (b?.segmentIndexInParent ?? 0));
      for (let i = 0; i < siblings.length; i++) {
        const s = siblings[i];
        if (!s || removed.has(s)) continue;
        const dur = Number(s.durationMs) || (Number(s.endMs) - Number(s.startMs));
        if (!Number.isFinite(dur) || dur >= FRAGMENT_MS) continue;
        const prev = i > 0 ? siblings[i - 1] : null;
        const prevEnd = prev && !removed.has(prev) ? Number(prev.endMs) : NaN;
        if (prev && Number.isFinite(prevEnd) && Math.abs(Number(s.startMs) - prevEnd) <= TIME_TOLERANCE_MS) {
          prev.endMs = s.endMs;
          prev.durationMs = Number(prev.endMs) - Number(prev.startMs);
          removed.add(s);
          continue;
        }
        const next = i + 1 < siblings.length ? siblings[i + 1] : null;
        const nextStart = next && !removed.has(next) ? Number(next.startMs) : NaN;
        if (next && Number.isFinite(nextStart) && Math.abs(nextStart - Number(s.endMs)) <= TIME_TOLERANCE_MS) {
          next.startMs = s.startMs;
          next.durationMs = Number(next.endMs) - Number(next.startMs);
          removed.add(s);
        }
      }
    }
    if (removed.size === 0) return;
    for (let i = segments.length - 1; i >= 0; i--) {
      if (removed.has(segments[i])) segments.splice(i, 1);
    }
    AppLogger.info(LOG_TAGS.AI_AGENT, `[镜头匹配] P2.0 碎片清洗：合并剔除 ${removed.size} 个 <${FRAGMENT_MS}ms 碎片 seg`);
  }

  /**
   * 🎙️ 原声段落定位：把文案中的原声引用文本与 ASR 时间轴做包含匹配，
   * 找到原声在原片中的时间段，再锁定覆盖该时间段的视频切片（切片自带原声轨）。
   * 未命中返回 null，调用方回退语义匹配。
   * @param text 原声引用文本（LLM 填写的原声台词原文）
   * @param asrLines ASR 时间轴 [{ text, startMs, endMs }]
   * @param videoChunks 视频切片池 [{ id, startMs, endMs, coverPath }]
   */
  static locateOriginalClip(
    text: string,
    asrLines: any[],
    videoChunks: any[],
    /** 段落画面锚点（源坐标 ms）：原声段对应 chunk 的时间窗，用于在 ASR 轴内收窄候选，避免跨镜头误匹配 */
    anchorStartMs?: number,
    anchorEndMs?: number,
  ): { chunkId: string; coverPath: string; chunkData: any; audioDurationMs: number; videoTimelineStartMs: number; videoTimelineEndMs: number } | null {
    if (!Array.isArray(videoChunks) || videoChunks.length === 0) {
      return null;
    }
    /** 1. 在 ASR 时间轴中找与原文最贴近的行（时间锚点收窄 + 最长包含匹配，避免短句/跨镜头误命中） */
    const win = SemanticAnalyzeStrategy.findAsrSourceWindow(text, asrLines, anchorStartMs, anchorEndMs);
    if (!win) {
      // 🔧 2026-09-14 原声定位失败分层诊断：ASR 文本时间窗未命中
      AppLogger.warn(LOG_TAGS.AI_AGENT,
        `[镜头匹配] 原声段落定位失败: ASR文本时间窗未命中 | asrLines=${asrLines?.length} anchor=${Number.isFinite(anchorStartMs) ? anchorStartMs : '-'}~${Number.isFinite(anchorEndMs) ? anchorEndMs : '-'}`);
      return null;
    }
    const startMs = win.sourceStartMs;
    const endMs = win.sourceEndMs;

    /** 2. 找覆盖 [startMs, endMs] 时间窗的切片（优先完整覆盖，其次 ±500ms 容差）。
     *    切片天然按 startMs 升序，用二分 O(log C) 定位到 startMs 附近，再在相邻 2-3 个切片内判定覆盖。 */
    const chunk = SemanticAnalyzeStrategy.findCoveringChunk(videoChunks, startMs, endMs, 0)
      || SemanticAnalyzeStrategy.findCoveringChunk(videoChunks, startMs + 500, endMs - 500, 0);
    if (!chunk) {
      // 🔧 2026-09-14 原声定位失败分层诊断：文本窗命中但无覆盖切片
      AppLogger.warn(LOG_TAGS.AI_AGENT,
        `[镜头匹配] 原声段落定位失败: 文本窗命中但切片未覆盖 | 窗口=${Math.round(startMs)}~${Math.round(endMs)}ms segs=${videoChunks?.length}`);
      return null;
    }

    return {
      chunkId: chunk.id || '',
      coverPath: chunk.coverPath || '',
      chunkData: chunk,
      audioDurationMs: endMs - startMs,
      videoTimelineStartMs: startMs,
      videoTimelineEndMs: endMs,
    };
  }

  /**
   * 🎙️ 纯 ASR 时间窗定位：在 ASR 时间轴中找到与原文最贴近的行（归一化 + 最长双向包含匹配），
   * 返回该行在原片中的 [sourceStartMs, sourceEndMs] 源坐标时间窗。
   *
   * 与 locateOriginalClip 的区别：本方法只做时间轴定位、不要求存在覆盖切片。
   * 供步骤3 文案生成阶段为原声保留段直接锚定精确原声时间窗（此时尚无切片覆盖需求），
   * 也供 locateOriginalClip 内部复用（同一坐标系契约：源坐标毫秒）。
   * 未命中返回 null，调用方按自身语义回退（步骤3 回退 chunk 时间轴 / 步骤5 回退语义匹配）。
   *
   * @param text 原声引用文本（LLM 填写的原声台词原文）
   * @param asrLines ASR 时间轴 [{ text, startMs, endMs }]（源坐标）
   * @returns 源坐标时间窗；无命中返回 null
   */
  static findAsrSourceWindow(
    text: string,
    asrLines: any[],
    /** 段落画面锚点（源坐标 ms）：原声段对应画面区间，用于在 ASR 轴内收窄候选，避免台词重复时跨镜头误匹配 */
    anchorStartMs?: number,
    anchorEndMs?: number,
  ): { sourceStartMs: number; sourceEndMs: number } | null {
    if (!text || !Array.isArray(asrLines) || asrLines.length === 0) {
      return null;
    }
    /** 归一化：去空白 + 去引号，做宽松包含匹配 */
    const norm = (t: string) => (t || '').replace(/\s+/g, '').replace(/[「」『』""''【】()（）]/g, '');
    const qText = norm(text);
    if (!qText) return null;

    /** 时间锚点窗口（有锚点则收窄）：原声台词必然落在对应画面区间内，±1s 容差 */
    const hasAnchor = Number.isFinite(anchorStartMs) && Number.isFinite(anchorEndMs)
      && (anchorEndMs as number) > (anchorStartMs as number);
    const winStart = hasAnchor ? (anchorStartMs as number) - 1000 : -Infinity;
    const winEnd = hasAnchor ? (anchorEndMs as number) + 1000 : Infinity;

    /**
     * 在 [lo, hi] 时间窗内收集与 qText 有包含关系的 ASR 行。
     * 过滤纯语气词/超短行（<2 汉字），避免"嗯/啊"这类短行污染时间窗。
     */
    const collect = (lines: any[], lo: number, hi: number): any[] => {
      const out: any[] = [];
      for (const line of lines) {
        const s = Number(line.startMs);
        const e = Number(line.endMs);
        if (Number.isFinite(s) && (s > hi || e < lo)) continue; // 时间窗过滤
        const lineText = norm(line.text || line.originalText || '');
        if (!lineText) continue;
        const hanCount = (lineText.match(/[\u4e00-\u9fa5]/g) || []).length;
        if (hanCount < 2 && lineText.length < 4) continue;
        if (qText.includes(lineText) || lineText.includes(qText)) out.push(line);
      }
      return out;
    };

    /** 先在锚点窗口内找；窗口内无命中时退回全轴（老数据/无锚点场景） */
    let matched = hasAnchor
      ? collect(asrLines, winStart, winEnd)
      : collect(asrLines, -Infinity, Infinity);
    if (matched.length === 0 && hasAnchor) {
      matched = collect(asrLines, -Infinity, Infinity);
    }
    if (matched.length === 0) return null;

    /** 按时间排序后合并连续/重叠行：台词被 ASR 切成多行时，合并成完整台词时间窗（≤1s 停顿视为同句） */
    matched.sort((a, b) => (Number(a.startMs) || 0) - (Number(b.startMs) || 0));
    const segs: Array<{ start: number; end: number }> = [];
    let cur = {
      start: Number(matched[0].startMs) || 0,
      end: Number(matched[0].endMs) || (Number(matched[0].startMs) || 0) + 3000,
    };
    for (let i = 1; i < matched.length; i++) {
      const s = Number(matched[i].startMs) || 0;
      const e = Number(matched[i].endMs) || s + 3000;
      if (s <= cur.end + 1000) {
        cur.end = Math.max(cur.end, e);
      } else {
        segs.push(cur);
        cur = { start: s, end: e };
      }
    }
    segs.push(cur);

    /** 选覆盖最长的连续块作为台词时间窗（台词重复出现时取信息量最大的一处） */
    let bestSeg = segs[0];
    for (const seg of segs) {
      if (seg.end - seg.start > bestSeg.end - bestSeg.start) bestSeg = seg;
    }
    if (bestSeg.end <= bestSeg.start) return null;
    return { sourceStartMs: bestSeg.start, sourceEndMs: bestSeg.end };
  }

  /**
   * 🎙️ 按时间窗锁定 ASR 台词（原声定位【主路径】）：在锚点画面时间窗 [anchorStartMs, anchorEndMs]（±1s 容差）
   * 内，收集与窗口重叠的 ASR 台词行，按时间连续合并（≤1s 停顿视为同句），返回台词在原片中的源坐标时间窗。
   *
   * 设计纠正（2026-09-14）：原声段的音频源本质由"这段画面里说话的时间"决定，而非"LLM 回填文本能否对上 ASR"。
   * 此函数不依赖任何文本匹配——韩语/超长剧本/LLM 抄录不准等场景下同样能锁定，从根上消除
   * "audioSource 为空 → 步骤5 回退文本匹配再次失败"的整条失败链。文本匹配仅保留在窗口内多段台词
   * 需区分时（由调用方决定），不再作为锁定音频源的前提。
   *
   * @param asrLines ASR 时间轴 [{ text, startMs, endMs }]（源坐标）
   * @param anchorStartMs 锚点画面起始（源坐标 ms，原声段对应 chunk 的时间起点）
   * @param anchorEndMs 锚点画面结束（源坐标 ms）
   * @returns 源坐标台词时间窗；窗口内无有效台词返回 null
   */
  static findAsrWindowByTime(
    asrLines: any[],
    anchorStartMs?: number,
    anchorEndMs?: number,
  ): { sourceStartMs: number; sourceEndMs: number } | null {
    if (!Array.isArray(asrLines) || asrLines.length === 0) return null;
    const aStart = Number(anchorStartMs);
    const aEnd = Number(anchorEndMs);
    if (!Number.isFinite(aStart)) return null;
    const lo = aStart - 1000;
    const hi = (Number.isFinite(aEnd) && aEnd > aStart ? aEnd : aStart) + 1000;

    /** 收集窗口内台词行：过滤超短行/纯语气词（<2 汉字），与 findAsrSourceWindow 同款过滤，避免短响词污染窗口 */
    const lines: Array<{ s: number; e: number }> = [];
    for (const line of asrLines) {
      const s = Number(line.startMs);
      const e = Number(line.endMs);
      if (!Number.isFinite(s) || (Number.isFinite(e) ? e < lo : true) || s > hi) continue;
      const t = (line.text || line.originalText || '').replace(/\s+/g, '');
      if (!t) continue;
      const hanCount = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
      if (hanCount < 2 && t.length < 4) continue;
      lines.push({ s, e: Number.isFinite(e) && e > s ? e : s + 3000 });
    }
    if (lines.length === 0) return null;

    /** 按时间合并连续/重叠行（≤1s 停顿视为同句），选覆盖最长的连续块作为台词时间窗 */
    lines.sort((a, b) => a.s - b.s);
    const segs: Array<{ start: number; end: number }> = [];
    let cur = { start: lines[0].s, end: lines[0].e };
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].s <= cur.end + 1000) {
        cur.end = Math.max(cur.end, lines[i].e);
      } else {
        segs.push(cur);
        cur = { start: lines[i].s, end: lines[i].e };
      }
    }
    segs.push(cur);
    let bestSeg = segs[0];
    for (const seg of segs) {
      if (seg.end - seg.start > bestSeg.end - bestSeg.start) bestSeg = seg;
    }
    if (bestSeg.end <= bestSeg.start) return null;
    return { sourceStartMs: bestSeg.start, sourceEndMs: bestSeg.end };
  }

  /**
   * 切片覆盖查找（二分）：videoChunks 需按 startMs 升序（场景切片的天然顺序），
   * 定位到满足 chunk.startMs <= tgtStart 的最后一个切片，再检查其与前后 2 个邻居是否覆盖 [tgtStart, tgtEnd]。
   * 由于切片不重叠且单调，候选最多 3-5 个；整体 O(log C + 常数)，远好于旧实现两次 O(C) 的 .find。
   * @param videoChunks 切片池（按 startMs 升序）
   * @param tgtStart 需覆盖区间起点
   * @param tgtEnd 需覆盖区间终点（若 tgtEnd <= tgtStart 表示无效，直接回 null）
   * @param _scanRadius 保留参数（目前固定 ±2 邻居扫描，不向外暴露调参入口）
   */
  private static findCoveringChunk(
    videoChunks: any[],
    tgtStart: number,
    tgtEnd: number,
    _scanRadius: number,
  ): any | null {
    if (tgtEnd <= tgtStart) return null;
    const N = videoChunks.length;
    if (N === 0) return null;
    let lo = 0;
    let hi = N - 1;
    // 最后一个满足 chunk.startMs <= tgtStart 的索引
    let pos = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const midStart = Number(videoChunks[mid].startMs) || 0;
      if (midStart <= tgtStart) {
        pos = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    // 没有任何 chunk.startMs <= tgtStart，则从第一个开始扫
    const from = pos < 0 ? 0 : Math.max(0, pos - 2);
    const to = Math.min(N - 1, (pos < 0 ? 0 : pos) + 2);
    for (let i = from; i <= to; i++) {
      const c = videoChunks[i];
      const s = Number(c.startMs) || 0;
      const e = Number(c.endMs) || s;
      if (s <= tgtStart && e >= tgtEnd) return c;
    }
    return null;
  }

  /**
   * 🎙️ 最大重叠切片兜底：台词窗口跨切片边界（场景切分与台词不对齐）时，findCoveringChunk 的
   * "单切片全覆盖"约束必然落空。原声段只要求【画面/音频按 timeline 从源视频裁剪 + 切片作承载】，
   * 切片不重叠且按 startMs 升序时与窗口相交的切片是一段连续区间，取重叠量最大者即可。
   * ⚠️ 调用方必须保持 timeline = 台词精确窗口（不得改成切片边界），否则导出提取原声会错位。
   * @param videoChunks 切片池（按 startMs 升序，不重叠）
   * @param tgtStart 台词窗口起点
   * @param tgtEnd 台词窗口终点（tgtEnd <= tgtStart 视为无效，直接回 null）
   */
  private static findMaxOverlapChunk(
    videoChunks: any[],
    tgtStart: number,
    tgtEnd: number,
  ): any | null {
    if (tgtEnd <= tgtStart) return null;
    const N = videoChunks.length;
    if (N === 0) return null;
    let lo = 0;
    let hi = N - 1;
    // 与 findCoveringChunk 同款二分：最后一个满足 chunk.startMs <= tgtStart 的索引
    let pos = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const midStart = Number(videoChunks[mid].startMs) || 0;
      if (midStart <= tgtStart) {
        pos = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    // 从 pos 起向后扫到首个 startMs >= tgtEnd 为止（切片不重叠保证其后不再有重叠）
    let best: any | null = null;
    let bestOverlap = 0;
    for (let i = Math.max(0, pos); i < N; i++) {
      const c = videoChunks[i];
      const s = Number(c.startMs) || 0;
      if (s >= tgtEnd) break;
      const e = Number(c.endMs) || s;
      const overlap = Math.min(e, tgtEnd) - Math.max(s, tgtStart);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = c;
      }
    }
    return best;
  }

  /**
   * 🎯 Phase 2：Step3 scriptShots（query 端）visualIntent 100% 覆盖率兜底（纯 query 端，零额外 RPC）
   *
   * 适用场景（两种情况下触发填补）：
   *   1. LLM 完全漏写 visualIntent（空字符串 / 占位词如"无/none/未提供"）
   *   2. 前一层 ScriptGenStrategy 的 chunk 视觉上下文兜底只产出了 `【兜底】通用画面` 这种极弱句式
   *      （典型 8月12日项目：老数据 visualContext 没填，第一层 chunk 端兜底被迫走到极端 case）
   *
   * 设计原则（错就错，不造假 → 仅基于 scriptShot 自身的 text + emotion + characters 推导）：
   *   - 不编造新的人物、场景、动作：所有填入的词都来自 shot 本身已有的字段（text 取前 28 字；emotion 直接用；characters 已有人名）
   *   - 句式多样性：5 种模板轮选（镜头/情绪/人物/场景/动作），避免 KM 匹配时"所有段的 visualIntent 前 8 字都相同"造成的 TF-IDF 权重失衡
   *   - 真值不覆盖：已有合法 visualIntent（非占位词/长度≥6/非【兜底】开头）一律原样保留
   *   - 字数控制 20~40 字（与 Step3 LLM 原生 visualIntent 分布一致，避免 CLIP/分词截断）
   *
   * @param shot  单个 scriptShot（Step3 产出），至少含 text 字段
   * @param index 该 shot 在 scriptShots 数组内的下标（用于模板轮选，保证句式多样）
   * @returns     保证非空的 visualIntent 字符串
   */
  static ensureScriptShotVisualIntent<T extends {
    text?: string; emotion?: string; characters?: string[]; visualIntent?: string;
    shotId?: string; id?: string;
  }>(shot: T | null | undefined, index: number = 0): string {
    if (!shot) return '【通用画面】场景过渡镜头';
    const existing = String(shot.visualIntent || '').trim();

    // --- 占位词判断（命中任意一个就视为"空，需要兜底"） ---
    const WEAK_OR_PLACEHOLDER: RegExp[] = [
      /^(无|没有|未指定|未提供|未说明|none|null|empty|unknown|n\/a|\/|占位|待定)$/i,
      /^【(兜底)?】\s*(通用|画面|镜头)?(场景)?(过渡)?(镜头)?\s*$/u,     // 【兜底】通用画面 / 【兜底】 / 【兜底】场景过渡
      /^【兜底】通用画面.*$/u,                                            // 【兜底】通用画面开头（极弱句式）
    ];
    const isEmpty = (() => {
      if (!existing) return true;
      if (existing.length < 6) return true;                                  // 合法 visualIntent 至少 >=6 字
      for (const re of WEAK_OR_PLACEHOLDER) if (re.test(existing)) return true;
      return false;
    })();
    if (!isEmpty) return existing; // 已有合法 visualIntent → 不覆盖（真值优先）

    // 💥 Phase 2 bug 修复：先把 text 里的 1~4 字超短纯数字/标点/无意义语气词（比如 "嗯"/"9块"/"啊"/"19"）当成"文本过短"处理，
    //   避免 2-gram 提取产生垃圾关键词（9、块、嗯、啊、1），也避免前缀 "场景叙述：9" / "解说内容：嗯" 这种像 bug 的句式。
    //   🛑 2026-09-05 B5 补充：判据先净化 emoji/替换符（\uFFFD 等不可信字符）再统计——脏文本（如仅含 �）不得判为
    //   "有意义"而进普通模板产出 <8 字垃圾句；应落入下方受控镜头模板（NARRATIVE_HOLD）。
    const textRaw = String(shot.text || '').replace(/\r?\n/g, ' ').trim();
    const cleanRaw = textRaw
      .replace(/[\uFFFD\u200B-\u200D\uFEFF]/g, ' ')
      .replace(/[\u{1F000}-\u{1FAFF}\u{1F300}-\u{1F5FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ');
    const cleanTrim = cleanRaw.trim();
    const chineseChars = cleanTrim.match(/[\u4e00-\u9fa5]/g) || [];
    const hasMeaningfulText = (cleanTrim.length >= 8 || chineseChars.length >= 2);
    // 有意义时才用「净化后」文本进模板/关键词：脏字符（�/emoji）/纯空白不进入 visualIntent 生成
    const text = hasMeaningfulText ? cleanTrim.replace(/\s+/g, ' ') : '';
    const emotion = String(shot.emotion || '').trim();
    const characters: string[] = Array.isArray(shot.characters)
      ? shot.characters.filter((c: any) => typeof c === 'string' && c.trim()).map((c: string) => c.trim()).slice(0, 3)
      : [];
    const textShort = text.length > 28 ? text.slice(0, 28) + '…' : text;

    // 5 种模板轮选（用 index 做种子，保证相邻段落句式不重复，避免 TF-IDF 权重异常）
    // 💥 额外：如果"文本过短 + 无情绪 + 无人物"，额外启用 NARRATIVE_HOLD 模板（纯镜头语言过渡），避免垃圾 2-gram
    const TEXT_SHORT = !hasMeaningfulText && !emotion && characters.length === 0;
    const templateIdx = TEXT_SHORT ? -1 : (Math.max(0, index | 0) % 5);
    const emotionPart = emotion ? `，情绪基调：${emotion}` : '';
    const charactersPart = characters.length > 0 ? `，人物：${characters.join('、')}` : '';

    // 关键词 2-gram（仅在"有意义文本"时启用，短语气词时不产生垃圾关键词）
    const kwFromText = new Set<string>();
    if (hasMeaningfulText) {
      const chars = Array.from(text.slice(0, 40));
      // 💥 优化：滑动 2-gram 后，过滤掉常见"停用 2-gram"（的老、我老、老舅、舅怎、的老 这种邻接无意义组合）
      const STOP_2GRAM = new Set(['的了', '了的', '是我', '我的', '你的', '他的', '我们', '你们', '他们',
        '一个', '这个', '那个', '这些', '那些', '就是', '不是', '还是', '或者', '然后', '之后', '接着', '因为', '所以',
        '一下', '一起', '一点', '没有', '还有', '只能', '只是', '的老', '我老', '老舅', '舅怎', '的家', '家里']);
      for (let i = 0; i < chars.length - 1; i++) {
        const a = chars[i]; const b = chars[i + 1];
        if (!/[\u4e00-\u9fa5]/.test(a) || !/[\u4e00-\u9fa5]/.test(b)) continue;
        const key = a + b;
        if (STOP_2GRAM.has(key)) continue;
        kwFromText.add(key);
      }
    }
    const kws = Array.from(kwFromText).slice(0, 4);

    const NARRATIVE_HOLD_TEMPLATES = [
      // 语气词/过短文本：景别开头 + 过渡叙事（完全不编造细节）
      '【中景】过渡镜头，承接前序叙事节奏',
      '【全景】过场画面，整体氛围延续',
      '【近景】停顿镜头，强调情绪变化',
      '【中景】场景衔接，叙事继续推进',
      '【全景】过渡画面，保持叙事连贯',
    ];

    const templates: string[] = [
      // 模板 0：镜头语言开头 → 解说词核心内容
      `【中景】解说词：${textShort || '过渡叙事'}${emotionPart}${charactersPart}`,
      // 模板 1：情绪氛围开头 → 人物动作（从 text 摘关键词）
      `${emotion ? `【${emotion}氛围】` : '【舒缓叙述】'}${charactersPart ? charactersPart.slice(1) + '：' : ''}${kws.length > 0 ? kws.join('、') + '，' : ''}${textShort || '叙事推进'}`,
      // 模板 2：人物锚定开头 → 核心动作/场景
      `${characters.length > 0 ? `人物 ${characters.join('&')}：` : '场景叙述：'}${textShort || '故事过渡镜头'}${emotionPart}`,
      // 模板 3：内容 + 关键词并列（和 chunk.description 的"看点"句式对齐，提升与 chunk 的 cosine 命中）
      `解说内容：${textShort || '通用场景'}${kws.length > 0 ? `；关键词：${kws.join('、')}` : ''}${emotionPart}`,
      // 模板 4：中景/全景 + 时间/情绪 综合（视觉化更具体）
      `${(index % 2 === 0) ? '【中景】' : '【全景】'}${textShort || '叙事镜头'}${charactersPart}${emotionPart}${kws.length > 2 ? `，看点：${kws.slice(0, 3).join('、')}` : ''}`,
    ];
    let result = (templateIdx === -1)
      ? NARRATIVE_HOLD_TEMPLATES[(Math.max(0, index | 0)) % NARRATIVE_HOLD_TEMPLATES.length].trim()
      : templates[templateIdx].trim();

    // 长度校验：超过 48 字保留景别/情绪前缀截断（控制 CLIP 分词压力）
    if (result.length > 48) {
      const prefixMatch = result.match(/^【[^】]*】/);
      const prefix = prefixMatch ? prefixMatch[0] : '';
      const rest = prefix ? result.slice(prefix.length) : result;
      const maxRest = 48 - prefix.length;
      result = prefix + (rest.length > maxRest ? rest.slice(0, maxRest) : rest);
    }
    // 🛑 2026-09-05 B5：删除"极端兜底也要造一句 ≥8 字 visualIntent"的造假逻辑——
    //   模板恒有产出；万一为空，宁可真值缺失（上游走解说词文本匹配），也不编造画面意图误导 KM。
    return result;
  }

  /**
   * 🎯 Phase 2 便捷入口：对整个 scriptShots 数组批量跑 visualIntent 兜底。
   * 返回新数组（浅拷贝每个元素并赋值 visualIntent），不原地修改输入对象，避免破坏 canvas_data 原始快照。
   *
   * @param scriptShots Step3 / canvas_data 读出来的原始 scriptShots（可能含 visualIntent 空/占位词的老项目）
   * @returns            visualIntent 100% 非空的新 scriptShots 数组（浅拷贝）
   */
  static ensureAllVisualIntentFilled<T extends {
    text?: string; emotion?: string; characters?: string[]; visualIntent?: string; shotId?: string;
  }>(scriptShots: T[] | null | undefined): T[] {
    if (!Array.isArray(scriptShots)) return [];
    return scriptShots.map((s, idx) => {
      const filled = SemanticAnalyzeStrategy.ensureScriptShotVisualIntent(s, idx);
      // 浅拷贝：只覆写 visualIntent 字段，其他字段原样继承（避免污染 canvas_data）
      if (String(s?.visualIntent || '').trim() === filled) return s;
      return { ...(s as any), visualIntent: filled } as T;
    });
  }

  /** 函数级中文注释：统一归一化 scriptShot 的时间锚（startMs/durationMs），解决 8/19 项目「台词一句也对不上」的 Bug B。
   * 数据来源有两套契约（老项目只有 start/end 秒值，新项目 Step3 会写入 startMs/durationMs 毫秒）：
   *   1. 【真值不覆盖】若存在 startMs/durationMs（毫秒，明确字段）→ 直接四舍五入取整（不二次 ×1000）
   *   2. 否则 fallback 到 start/end（秒字段，ASR 工具链输出）→ ×1000 转毫秒
   *   3. 边界保护：durationMs 必须 ≥ 0；若缺失且缺 end 字段则 0 兜底 */
  private static _resolveScriptShotTiming(shot: any): { startMs: number; durationMs: number } {
    // 1) startMs 真值优先（毫秒）
    let startMs: number = 0;
    if (typeof shot?.startMs === 'number' && Number.isFinite(shot.startMs)) {
      startMs = Math.round(shot.startMs);
    } else if (typeof shot?.start === 'number' && Number.isFinite(shot.start)) {
      // 2) 秒字段 → ×1000
      startMs = Math.round(shot.start * 1000);
    }

    // 1) durationMs 真值优先（毫秒）
    let durationMs: number = 0;
    if (typeof shot?.durationMs === 'number' && Number.isFinite(shot.durationMs)) {
      durationMs = Math.round(shot.durationMs);
    } else if (typeof shot?.end === 'number' && typeof shot?.start === 'number'
      && Number.isFinite(shot.end) && Number.isFinite(shot.start)) {
      // 2) 有秒级起止 → 差 ×1000，且必须 ≥0
      durationMs = Math.max(0, Math.round((shot.end - shot.start) * 1000));
    } else if (typeof shot?.duration === 'number' && Number.isFinite(shot.duration)) {
      // 3) 个别链路给的是 duration（秒）兜底
      durationMs = Math.max(0, Math.round(shot.duration * 1000));
    }
    return { startMs, durationMs };
  }

  /**
   * 构造镜头匹配的查询段落列表（纯函数，去重 AIService 与本策略的双份实现）。
   * 负责：
   *  - shotId 生成（按 s.shotId / s.id 兜底的顺序编号 para_i）
   *  - TTS 时长匹配：先按位置兜底 i，再按 shotId→TTS 的 Map 索引修正（O(1)）
   *  - 注入多维匹配字段：text / emotion / characters / visualIntent / startMs / durationMs / keepOriginalAudio
   *  - 过滤掉无文案的段落
   *  - 🎯 Phase 2：自动对所有 scriptShots 做 ensureAllVisualIntentFilled，保证 query 端 visualIntent 100% 非空
   *    （同时把 visualIntent 拼到 text 字段末尾，用"文本拼接"方式让任何纯文本相似度打分器都能吃到 visualIntent 信号 —
   *     这样 preselectTopK 的 TF-IDF 打分器、KM 内部的文本代价函数都能零改动地利用 visualIntent）
   * 调用方如果只需 "最少字段集"（AIService 的旧契约），直接取 shotId/text/audioDurationMs 即可；
   *   KM 求解会忽略未用字段，不会产生副作用。
   *  - 🎯 匹配单位（2026-09-18，方案 §23.12）：`ZENTECT_SCRIPT_MATCH_UNIT=sentence` 时先按碎片上的 matchUnitId
   *    折叠成"匹配单位（一个完整句）"，**每个单位只产出一条 query**（同簇碎片不再各自独立匹配却被母句
   *    visualIntent 绑死同一答案）；`legacy`（默认）档每碎片一条，取值路径与现状逐字节一致。
   *    结果回填约定：KM 以单位 id（query.shotId）返回，调用方按碎片自身 matchUnitId 展开回该单位覆盖的全部碎片，
   *    保证 matchResults 数量恒等于段落数（TTS/字幕/导出结构不变）。
   * @param scriptShots 步骤3 产出的解说文案段落数组（含 text/emotion/visualIntent...）
   * @param ttsDurations 步骤4 产出的配音结果数组（含 shotId/duration）
   */
  static buildMatchQueries(
    scriptShots: any[],
    ttsDurations: any[],
    /** 🔧 模式 A（2026-09-05）：全链路恒【源坐标】——query.startMs 与 audioSource 均保持源坐标透传，
     *  不再做 body 转换（候选切片坐标同为源）。参数保留仅为调用方兼容，已弃用（内部忽略）。 */
    _trimStartMs: number = 0,
    /** 🎭 人物归一（2026-09-18）：项目 id，用于定位 `data/projects/<projectId>/person_registry.json`。
     *  缺省时可退化为 dev 兜底注册表；都没有则 charIds 恒为空数组（daemon 侧回退旧 characters 行为）。 */
    projectId?: string,
    /** 🔒 B域（§10.2.3 动作2）：媒体物理坐标（resolveForMedia 产物），供锁1 位置校正透传
     *  trimStartMs/sourceDurationMs。缺省时 query 不追加这两字段（旧调用方零行为变化）。 */
    mediaPhys?: { trimStartMs?: number; srcDurationMs?: number },
    /** 📗 步骤1 ③ 气口：ASR 时间轴（含 silenceGapMs），供原声段 query 注入句尾静音气口（补丁2/7 消费）。缺省为 undefined（旧调用方零变化）。 */
    asrLines?: any[],
  ): Array<{
    shotId: string;
    text: string;
    audioDurationMs: number;
    emotion: string;
    characters: string[];
    /** 🎭 人物归一（2026-09-18）：本段文案/画面意图按注册表 aliasesHigh 子串命中得到的角色主键集合。
     *  与 characters 并存（characters 保持原样不破坏既有链路），daemon 侧 role_score 优先消费本字段。 */
    charIds: string[];
    visualIntent: string;
    startMs: number;
    durationMs: number;
    keepOriginalAudio: boolean;
    /** 🎙️ 原声段精确源时间窗（步骤3 已锚定，body 坐标）：定位优先直用，缺省=非原声段或上游未锚定 */
    audioSourceStartMs?: number;
    audioSourceEndMs?: number;
    /** 🎬 批1 语义翻译层：query 地点约束（SCENE_GROUPS 组名；空=该段无地点约束）。
     *  VI 绝对优先 → 正文兜底；daemon 侧组等值命中才触发场景加成 / 窗口豁免。 */
    sceneGroup?: string;
    /** 🎬 批1 语义翻译层：query 情绪终点态（平静舒缓/欢快轻松/紧张悬疑/悲伤沉重/愤怒激昂/中性）。
     *  VI 闸门优先锁定，正文仅在 VI 无情绪词时兜底；daemon 非空时替换 q.emotion 进 emotion_sim。 */
    moodIntent?: string;
    /** 🎬 决策 #6（ADR-003）：抽象文案路由标记透传（=== true 规范化，老数据无字段即 false） */
    isAbstractNarration?: boolean;
    /** 🎬 决策 #2 契约化（ADR-003）：显式闪回标记透传（优先级高于 KM 内部时间豁免关键词猜测） */
    isFlashback?: boolean;
    /** 🎯 参考帧锚点（步骤3 产出的真实画面锚点，源视频坐标）：本层仅透传、不消费，
     *  供 daemon 请求体携带，后续"以真实画面锚点为 query"的重构使用。 */
    refFrameTimeMs?: number;
    /** 🎯 参考帧画面描述（步骤2 帧描述；退化段为空字符串） */
    refFrameDesc?: string;
    /** 🎯 参考帧来源：matched=命中真实帧 / block_first=退化为母块首帧时间 */
    refFrameSource?: 'matched' | 'block_first';
    /** 🔒 B域（§10.2.3 动作2）：锁1 位置校正媒体物理坐标透传——
     *   trimStartMs=已裁片头偏移（补丁4 幻觉守卫用）；sourceDurationMs=源视频总时长（越界守卫用）。 */
    trimStartMs?: number;
    sourceDurationMs?: number;
    /** 🎯 匹配单位（2026-09-18）：本 query 所属「完整句」的 id（sentence 档由步骤3 断句器写入碎片）。
     *  折叠前=碎片所属单位 id（回填依据）；折叠后=query 自身 id（shotId）。legacy 档上游不写该字段 ⇒ 产物零变化。 */
    matchUnitId?: string;
    /** 📗 步骤1 ③ 气口：原声段句尾静音气口毫秒（补丁2/7 磁吸消费）；非原声段/N 锚失配恒 undefined（中性放行，不造假）。 */
    silenceGapMs?: number;
  }> {
    const { filledShots, ttsById, queryAliasTable } =
      SemanticAnalyzeStrategy._prepareMatchQueryContext(scriptShots, ttsDurations, projectId);
    /** 🎯 匹配单位（2026-09-18）：sentence 档先按碎片上的 matchUnitId 折叠成"匹配单位"（一个完整句 = 一个单位），
     *  每个单位只产出一条 query；legacy 档每个碎片自成一个单位（数量/顺序/取值路径全不变 ⇒ 与现状逐字节等价，
     *  且不写出 matchUnitId 字段——上游若带该字段也一律剔除，保证 legacy 产物形态与线上完全一致）。 */
    const useSentenceUnit = resolveScriptMatchUnitMode() === 'sentence';
    const units: Array<{ unitId: any; shots: any[] }> = useSentenceUnit
      ? collapseShotsToMatchUnits(filledShots).map((g) => ({ unitId: g.matchUnitId, shots: g.shots as any[] }))
      : filledShots.map((s: any) => ({ unitId: s.id, shots: [s] }));
    return units
      .map((u) => SemanticAnalyzeStrategy._buildMatchQueryFromShots(u.shots, u.unitId, ttsById, queryAliasTable, useSentenceUnit, mediaPhys, asrLines))
      .filter((q) => (q.text.split('|')[0] || '').trim().length > 0);
  }

  /**
   * 函数级中文注释：query 构造的公共预置上下文（折叠 / 不折叠两条路径共用，杜绝口径漂移）。
   *  - filledShots：visualIntent 兜底填充后的段落碎片（Phase 2：保证 query 端 visualIntent 100% 非空）；
   *  - ttsById：TTS 产物索引（按段落主键 O(1) 取时长，避免 N×M .find 热点）；
   *  - queryAliasTable：人物注册表别名表（query 侧与切片侧**同一张**，无注册表则为空表）。
   *
   * @param scriptShots 步骤3 产出的解说文案段落数组（含 text/emotion/visualIntent...）
   * @param ttsDurations 步骤4 产出的配音结果数组（含 id/duration）
   * @param projectId 项目 id（定位 data/projects/<projectId>/person_registry.json；缺省退化为 dev 兜底表）
   * @returns 构造 query 所需的预置上下文
   */
  private static _prepareMatchQueryContext(
    scriptShots: any[],
    ttsDurations: any[],
    projectId?: string,
  ): { filledShots: any[]; ttsById: Map<string, any>; queryAliasTable: ReturnType<typeof loadPersonAliasTable> } {
    // 🎯 Phase 2：Step5 二次兜底 — 保证所有 query 的 visualIntent 100% 非空（老项目 canvas_data 里的 shots 也能覆盖）
    const filledShots = SemanticAnalyzeStrategy.ensureAllVisualIntentFilled(scriptShots || []);
    /** TTS 索引：按 id 一次 O(N) 建，单次查询 O(1)，避免 N×M .find 热点；
     *  ✅ 身份键统一：TTS 产物 id/shiedId 同源即段落主键，一律按 id 关联 */
    const ttsById = new Map<string, any>();
    for (const t of ttsDurations || []) {
      const id = (t as any)?.id || (t as any)?.shotId;
      if (id) ttsById.set(String(id), t);
    }
    /** 🎭 人物归一（2026-09-18）：query 侧复用与切片侧**同一张**别名表（按项目加载，无注册表则为空表）。 */
    const queryAliasTable = loadPersonAliasTable(projectId);
    return { filledShots, ttsById, queryAliasTable };
  }

  /**
   * 函数级中文注释：碎片级 query 列表（每个碎片一条，口径 = 线上现状），仅供本策略内部的结果回填 / 流式卡片使用。
   *
   * 为什么需要它：sentence 档下"送 KM 的 query"已折叠成"一个完整句一条"，但下游（matchResults / 字幕 / 导出 /
   * 前端卡片）必须仍是段落粒度——折叠只发生在 query 侧，回填侧照旧按碎片取值（文本、时长、原声窗各归各碎片）。
   * 与 buildMatchQueries 共用 _prepareMatchQueryContext 与 _buildMatchQueryFromShots，两套视图不会漂移。
   *
   * @param scriptShots 步骤3 产出的解说文案段落数组
   * @param ttsDurations 步骤4 产出的配音结果数组
   * @param projectId 项目 id（人物注册表定位）
   * @returns 碎片级 query 列表（顺序 = 文案顺序）
   */
  private static _buildShotLevelQueries(
    scriptShots: any[],
    ttsDurations: any[],
    projectId?: string,
  ): ReturnType<typeof SemanticAnalyzeStrategy.buildMatchQueries> {
    const { filledShots, ttsById, queryAliasTable } =
      SemanticAnalyzeStrategy._prepareMatchQueryContext(scriptShots, ttsDurations, projectId);
    return filledShots
      .map((s: any) => SemanticAnalyzeStrategy._buildMatchQueryFromShots([s], s.id, ttsById, queryAliasTable, true))
      .filter((q) => (q.text.split('|')[0] || '').trim().length > 0);
  }

  /**
   * 函数级中文注释：由"一个匹配单位覆盖的碎片"构造单条匹配 query。
   *
   * 单碎片单位（legacy 档全量 / 未拆分叙事段 / 原声段）与现状取值逐字段一致、键序一致；
   * 多碎片单位（sentence 档的一个完整句）按"回卷成完整句"口径折叠：
   *  - text：各碎片正文字面拼接（还原完整句，碎片自带标点保留），visualIntent 只追加一次（与碎片级同格式）；
   *  - audioDurationMs：各碎片 TTS 时长之和（KM 时长代价按"整句承载时长"口径）；
   *  - startMs/durationMs：组内外包区间（最小起点 → 末片右端），attachQueryWindow 据此派生整句段落窗口；
   *  - 代表值：visualIntent/emotion/sceneGroup/moodIntent/参考帧锚点 取组内首个非空（碎片继承自同一母句，通常同值）；
   *  - 原声判定 / 抽象 / 闪回标记：任一碎片为真即为真；原声时间窗取组内首个有效项（原声段不参与断句，组内恒单碎片）；
   *  - charIds：对"整句正文 + visualIntent"统一扫描（与碎片级同表同算法），折叠不丢角色命中；
   *    🛑 人物（characters / charIds）始终只作软排加成信号，永不参与硬门禁。
   *
   * @param shots 该匹配单位覆盖的碎片（顺序即文案顺序；未折叠时恒为单元素）
   * @param unitId 匹配单位 id（= query.shotId；未折叠为碎片自身 id，折叠后为完整句 id）
   * @param ttsById TTS 产物索引（按段落主键）
   * @param queryAliasTable 人物注册表别名表（query 侧与切片侧同表）
   * @param emitMatchUnitId 是否写出 matchUnitId 字段：sentence 档 true（回填依据）；
   *        legacy 档 false ⇒ 产物字段集与线上逐字节一致（上游数据即使带该字段也不透传）
   * @returns 一条匹配 query
   */
  private static _buildMatchQueryFromShots(
    shots: any[],
    unitId: any,
    ttsById: Map<string, any>,
    queryAliasTable: ReturnType<typeof loadPersonAliasTable>,
    emitMatchUnitId: boolean,
    /** 🔒 B域（§10.2.3 动作2）：媒体物理坐标『源视频坐标：trimStartMs/sourceDurationMs』。 */
    mediaPhys?: { trimStartMs?: number; srcDurationMs?: number },
    /** 📗 步骤1 ③ 气口：ASR 时间轴（含 silenceGapMs），供原声段 query 注入句尾静音气口。缺省 undefined（旧调用方零变化）。 */
    asrLines?: any[],
  ): ReturnType<typeof SemanticAnalyzeStrategy.buildMatchQueries>[number] {
    const s = shots[0];
    // ✅ 身份键统一：段落主键 id（出生处 seg_{idx} 全局唯一）为唯一身份键，shotId 与其同源；
    //   折叠后 shotId 收敛为"匹配单位 id"（既有 id 形态：母段落 id 或 {母段落id}_s{n}），出结果再按碎片 matchUnitId 回填。
    const shotId = unitId;
    /** 🔊 刚性音频时长：单碎片 = 自身 TTS 时长；多碎片 = 整句各碎片 TTS 时长之和 */
    let audioDurationMs = 0;
    for (const shot of shots) {
      const tts = ttsById.get(String(shot.id));
      if (tts?.duration) audioDurationMs += Math.round(tts.duration * 1000);
    }
    const visualIntent = String(s.visualIntent || '').trim();
    /** 原声判定双口径：上游段落经 Normalizer 净化后只有 type 判别标记，老项目段落仍是 legacy keepOriginalAudio 布尔 */
    const isOriginal = shots.some((shot: any) => shot.type === 'original_audio' || shot.keepOriginalAudio === true);
    /** 🎯 参考帧锚点等"代表值"取值口径：组内首个非空项（碎片继承自同一母句，正常同值；缺失留空不瞎猜） */
    const pickFirst = <T>(pick: (shot: any) => T | undefined): T | undefined => {
      for (const shot of shots) {
        const v = pick(shot);
        if (v !== undefined && v !== null) return v;
      }
      return undefined;
    };
    // 🎯 Phase 2：把 visualIntent 拼接到 text 末尾（独立段落符号 | 分隔），
    //   让纯文本相似度打分（preselectTopK / KM / VLM 文本匹配）零改动就能吃 visualIntent 信号。
    //   比例控制：text 仍占主要权重（不重复、不重写），visualIntent 作为补充 tag 追加。
    //   🎯 折叠：多碎片单位的正文按碎片顺序字面拼接，回卷成"完整句"全文（碎片自带标点保留，不额外插分隔符）。
    const baseText = shots
      .map((shot: any) => {
        const textRaw = shot.text || shot.content || shot.narration || '';
        // 🔧 原声段台词保存在 audioSource.transcript，主字段 text 恒为空——空文本段会被末尾
        //   filter 整段丢弃，导致原声段不进定位队列、不进 KM、matchResults 完全缺失
        //   （步骤5 无"原声"卡片、导出时间线丢段）。故原声段先回填 transcript
        //   （剥"原声："播报前缀）再统一走过滤。
        const transcript = String(shot.audioSource?.transcript || '').replace(/^原声[:：]\s*/, '').trim();
        const isOriginalShot = shot.type === 'original_audio' || shot.keepOriginalAudio === true;
        return textRaw || (isOriginalShot ? transcript : '');
      })
      .join('');
    const text = visualIntent.length > 0 ? `${baseText} | ${visualIntent}` : baseText;
    /** 🎭 人物归一（2026-09-18）：对「整句文案 + visualIntent」做同一张表的长串优先子串扫描，
     *  得到本段期望角色主键集合。未命中即空数组（不瞎猜）；无注册表时恒空（零行为变化）。
     *  🛑 人物只作软排加成信号，任何情况下都不得升级为硬门禁。 */
    const charIds = matchCharIdsInTexts([baseText, visualIntent], queryAliasTable);
    // 🎬 批1 语义翻译层（N4）：sceneGroup 地点约束「VI 绝对优先 → 正文兜底」（R2-1 只做完整组词，防假阳性）；
    //   moodIntent 情绪终点态「VI 闸门」（R2-2：VI 命中情绪词立即锁定，正文一律不回退覆盖；
    //   VI 无情绪词才降级正文启发式，按转折取靠后终点状态——"喧闹…瞬间安静"→平静舒缓）。
    const sceneGroup = matchSceneGroup(visualIntent) || matchSceneGroup(baseText) || '';
    const moodIntent = moodIntentForText(visualIntent, false) || moodIntentForText(baseText, true) || '';
    // 🔧 修复 Bug B：之前只认 s.startMs / s.durationMs，老项目 / 只跑了 Step1 的项目只提供 start/end（秒），
    //   导致 startMs 全部变 0，Step5 overlap 推算永远打在 0ms，匹配结果一句也对不上。
    //   🎯 折叠：单碎片单位原样透传；多碎片单位取组内外包区间（碎片时间轴由断句器按前缀和铺排，
    //   首片起点 → 末片右端即"完整句"跨度），attachQueryWindow 据此派生整句段落窗口。
    const headTiming = SemanticAnalyzeStrategy._resolveScriptShotTiming(s);
    let startMsOut = headTiming.startMs;
    let endMsOut = headTiming.startMs + headTiming.durationMs;
    for (const shot of shots.slice(1)) {
      const t = SemanticAnalyzeStrategy._resolveScriptShotTiming(shot);
      startMsOut = Math.min(startMsOut, t.startMs);
      endMsOut = Math.max(endMsOut, t.startMs + t.durationMs);
    }
    const durationMsOut = shots.length === 1 ? headTiming.durationMs : Math.max(0, endMsOut - startMsOut);
    /** 📗 步骤1 ③ 气口：原声段按「原声时间窗 ↔ ASR 行」最大重叠匹配，取其句尾静音气口毫秒。
     *   - 仅原声段（keepOriginalAudio）匹配（TTS 旁白无 ASR 气口，恒 undefined → 补丁卡中性放行，不造假）；
     *   - 用 audioSource 源时间窗优先、退化用段落画面窗；与所有 ASR 行算重叠取最大者，重叠≤0 视为未命中；
     *   - 命中但该行无 silenceGapMs/非数值 → undefined（不猜默认值，守「错就错」）。 */
    const silenceGapMs = (() => {
      if (!isOriginal || !Array.isArray(asrLines) || asrLines.length === 0) return undefined;
      const winS = pickFirst((shot: any) => (typeof shot.audioSource?.sourceStartMs === 'number' ? shot.audioSource.sourceStartMs : undefined));
      const winE = pickFirst((shot: any) => (typeof shot.audioSource?.sourceEndMs === 'number' ? shot.audioSource.sourceEndMs : undefined));
      const ws = typeof winS === 'number' ? winS : startMsOut;
      const we = typeof winE === 'number' ? winE : startMsOut + durationMsOut;
      let best: any = undefined;
      let bestOv = 0;
      for (const line of asrLines) {
        const ls = Number(line?.startMs);
        const le = Number(line?.endMs);
        if (!Number.isFinite(ls) || !Number.isFinite(le)) continue;
        const ov = Math.min(le, we) - Math.max(ls, ws);
        if (ov > bestOv) {
          bestOv = ov;
          best = line;
        }
      }
      if (best === undefined) return undefined;
      const g = Number(best.silenceGapMs);
      return Number.isFinite(g) ? Math.max(0, Math.round(g)) : undefined;
    })();
    return {
      shotId,
      text,
      audioDurationMs,
      emotion: s.emotion || '',
      characters: Array.isArray(s.characters) ? s.characters : [],
      /** 🎭 人物归一（改写为注册表 charId，供 daemon role_score/routing 交集；characters 字段保持原样） */
      charIds,
      visualIntent,
      startMs: startMsOut,
      durationMs: durationMsOut,
      keepOriginalAudio: isOriginal,
      sceneGroup,
      moodIntent,
      /** 🔒 B域（§10.2.3 动作2）：锁1 位置校正所需的媒体物理坐标透传——
       *   trimStartMs=已裁片头偏移（补丁4 幻觉守卫：refFrame 落入 [0,trimStartMs) 判幻觉 +=trimStartMs）；
       *   sourceDurationMs=源视频总时长（越界守卫：refFrame>源时长判幻觉置 0）。 */
      trimStartMs: Math.max(0, Math.round(Number(mediaPhys?.trimStartMs) || 0)),
      sourceDurationMs: Math.max(0, Math.round(Number(mediaPhys?.srcDurationMs) || 0)),
      /** 🎙️ 原声段精确源时间窗（步骤3 写入为源坐标，模式 A 不再转 body）：供定位直接二分锁定源坐标切片。
       *  原声段不参与断句（组内恒单碎片），故"取组内首个有效项"与既有单段取值等价。 */
      audioSourceStartMs: isOriginal
        ? pickFirst((shot) => (typeof shot.audioSource?.sourceStartMs === 'number' ? shot.audioSource.sourceStartMs : undefined))
        : undefined,
      audioSourceEndMs: isOriginal
        ? pickFirst((shot) => (typeof shot.audioSource?.sourceEndMs === 'number' ? shot.audioSource.sourceEndMs : undefined))
        : undefined,
      /** 🎬 决策 #6（ADR-003）：抽象文案路由标记透传（=== true 规范化，老数据无字段即 false）；
       *  折叠口径：组内任一碎片为真即为真（碎片继承自同一母句，正常同值） */
      isAbstractNarration: shots.some((shot: any) => shot.isAbstractNarration === true),
      /** 🎬 决策 #2 契约化（ADR-003）：显式闪回标记透传（优先级高于 KM 内部时间豁免关键词猜测）；折叠口径同上 */
      isFlashback: shots.some((shot: any) => shot.isFlashback === true),
      /** 🎯 参考帧锚点透传（步骤3 产出，本层仅搬运不改口径）：
       *  daemon 侧 query 模型对未知字段宽容忽略，本次仅保证字段进入请求体。
       *  折叠口径：取组内首个非空项（碎片继承自同一母句的真实参考帧，正常同值；缺失留空）。 */
      refFrameTimeMs: pickFirst((shot) => (typeof shot.refFrameTimeMs === 'number' && Number.isFinite(shot.refFrameTimeMs)
        ? Math.round(shot.refFrameTimeMs)
        : undefined)),
      refFrameDesc: pickFirst((shot) => (typeof shot.refFrameDesc === 'string' ? shot.refFrameDesc : undefined)),
      refFrameSource: pickFirst((shot) => (shot.refFrameSource === 'matched' || shot.refFrameSource === 'block_first'
        ? shot.refFrameSource
        : undefined)),
      /** 🎯 匹配单位 id：碎片自身所属「完整句」的 id（sentence 档由步骤3 断句器写入；折叠后=本 query 自身 shotId）。
       *  步骤5 出结果后按该 id（既有映射）把"单位级命中"展开回该单位覆盖的全部碎片，数量守恒。
       *  legacy 档不写出（emitMatchUnitId=false）⇒ 与现状字段集完全一致。 */
      ...(emitMatchUnitId && typeof s.matchUnitId === 'string' && s.matchUnitId.trim()
        ? { matchUnitId: String(s.matchUnitId).trim() }
        : {}),
      /** 📗 步骤1 ③ 气口：原声段句尾静音气口毫秒（补丁2/7 磁吸消费）；非原声段/未命中 ASR 行恒省略（中性放行）。 */
      ...(silenceGapMs !== undefined ? { silenceGapMs } : {}),
    };
  }

  /**
   * P2 #11：KM Top-K 预选（方案 A：Node 侧整体收窄 videoChunks，不改 daemon 契约）。
   *
   * 设计要点：
   *   - 双通道打分融合：α·TF-IDF 文本相似度 + β·时间锚近邻分，不用 embedding，零额外 RPC
   *   - 动态 K：K = max(15, ceil(N·3.0), ceil(M·12%))，夹到 [15, M]，小项目自动回全量不失真
   *   - 质量保护：① 描述覆盖率 <30% 直接跳预选 ② 单 query 的 topK 时间跨度不足 3·audioDuration 就扩张
   *     ③ 候选并集 ≥ 2N（KM 排他性分配需要足够"预算池"）
   *   - 审计用 perQueryTopK：记录每个 query 的候选 chunkId 集合，KM 返回后用于计算"命中占比"
   *     （真实匹配 chunk 是否在预选集合里），低于 0.95 打 warn，方便后续调参。
   */
  static preselectTopK(
    queries: Array<{
      shotId: string; text: string; audioDurationMs: number;
      emotion?: string; visualIntent?: string; startMs: number; durationMs: number;
      /** 🎬 批1：地点约束组名（buildMatchQueries 产出）。非空时把同组切片强制并入候选集/并集，
       *  防"弱文本 + 远时序"的同组切片被 Top-K 整体剔除（KM 窗口豁免将无从触发）。 */
      sceneGroup?: string;
    }>,
    videoChunks: Array<{
      id: string; startMs: number; endMs: number; description?: string;
      emotion?: string; shotType?: string; characters?: string[];
      /** 🎬 批1：切片场景值（帧场景众数 / desc「场景:」回捞），供场景组保底入池映射 */
      scene?: string;
    }>,
    opts?: { alpha?: number; beta?: number; minDescCoverage?: number; logProjectId?: string },
  ): {
    /** 方案 A 真正传递给 KM 的 videoChunks 子集（多个 query 的 topK 的并集） */
    filteredChunks: any[];
    /** 每个 query 的 top-K 候选 chunkId（审计用，计算命中占比） */
    perQueryTopK: Record<string, string[]>;
    /** 动态 K（便于审计日志） */
    K: number;
    /** 预选前切片总数 */
    M0: number;
    /** 预选后切片总数（并集） */
    M1: number;
    /** 是否真正执行了预选（false=被保护规则跳过，直接用原全集） */
    applied: boolean;
  } {
    const N = queries.length;
    const M = videoChunks.length;
    const fallback = {
      filteredChunks: videoChunks,
      perQueryTopK: {},
      K: M, M0: M, M1: M, applied: false,
    };
    if (N === 0 || M === 0) return fallback;
    /** 🔧 权重再平衡（方案 A 修复）：预选是**召回闸门**，其职责是"别把正确切片砍掉"，
     *  精准的时空判定由 daemon 侧的 WINDOW_PENALTY + 场景豁免负责。此前 beta=0.45 让
     *  时间锚几乎与语义等权，配合错误的时间口径（见下方时间分注释）系统性漏召回。
     *  调为 语义 0.65 / 时间 0.35：语义主导，时间仍参与排序但不再一票否决。 */
    const alpha = opts?.alpha ?? 0.65;
    const beta = opts?.beta ?? 0.35;
    const minDescCoverage = opts?.minDescCoverage ?? 0.3;
    /** 🎯 预选时间窗（毫秒）：与 daemon `timeline_solver.py` 的 WINDOW_LEAD_MS/WINDOW_TAIL_MS
     *  保持同口径——前探 30s 覆盖章节铺垫、后延 60s 覆盖冲突发酵。两处必须同步修改。 */
    const PRESELECT_WINDOW_LEAD_MS = 30000;
    const PRESELECT_WINDOW_TAIL_MS = 60000;
    /** 候选池时间收敛（2026-09-20）：合法窗外再加软外扩，供"最近跨窗"候选轻微溢出，防止生硬截断。
     *  收敛边界 = [qSt−LEAD−CONV, qEnd+TAIL+CONV]，仅在窗界内/窗边补候选，杜绝"时间跨度扩张"摊到全片。 */
    const CONV_MARGIN_MS = 30000;

    /* ==========================================================
     * 🎯 修复-1 前处理：空描述 chunk 的相邻描述继承
     *   避免 VLM 漏写描述的切片（如 chunk_004 3s 牌匾裂开）在 TF-IDF 被打成 sText=0，
     *   直接从 top-K 预选淘汰。策略：优先找上一个有描述的邻居（画面连贯更可靠），
     *   没有再找下一个；在临时副本上补"【继承自xxx】描述"标记，不污染上游原数据。
     * ========================================================== */
    const inheritedChunks = videoChunks.map((c) => ({ ...c, _inheritedDesc: false as boolean | string }));
    for (let i = 0; i < inheritedChunks.length; i++) {
      const cur = inheritedChunks[i];
      if (!(cur.description || '').trim()) {
        let donor: typeof inheritedChunks[number] | null = null;
        for (let j = i - 1; j >= 0; j--) {
          if ((inheritedChunks[j].description || '').trim()) { donor = inheritedChunks[j]; break; }
        }
        if (!donor) for (let j = i + 1; j < inheritedChunks.length; j++) {
          if ((inheritedChunks[j].description || '').trim()) { donor = inheritedChunks[j]; break; }
        }
        if (donor) {
          cur.description = `【继承自${donor.id || '相邻切片'}画面延续】${donor.description}`;
          cur._inheritedDesc = donor.id || true;
        }
      }
    }
    const workingChunks: typeof videoChunks = inheritedChunks as any;

    /* ==========================================================
     * 🎯 修复-2 关键词精确匹配 boost 规则
     *   对"牌匾/裂开/老字号/鼎庆楼/手指抚摸"这类强视觉实体+动作关键词，
     *   在 Q.query 与 C.description 同时命中时给语义分加 bonus（并裁剪到 1.0），
     *   解决 TF-IDF 因 IDF 太平均导致强信号词（如"牌匾"在整个库中出现 3 次）的
     *   sText 只有 ~0.13，被"情绪 1.0 + 时长契合 0.95"等弱匹配抢占的问题。
     *   单个最高 0.20×3=0.60，总和 clamp 到 0.60，避免压倒图像/CLIP 主信号。
     * ========================================================== */
    const KEYWORD_BOOST_PAIRS: Array<[RegExp, RegExp, number]> = [
      // [query 侧命中, chunk 侧命中, bonus]
      // —— 实体类（高权重：牌匾/招牌是强视觉锚点）
      [/牌匾|招牌|匾额|老字号|鼎庆楼|门匾/, /牌匾|招牌|匾额|老字号|鼎庆楼|门匾|牌匾上|牌匾下|匾额上|匾额下/, 0.22],
      // —— 动作类（高权重：裂开/劈开是场景核心动词）
      [/裂|劈开|裂开|劈成|破碎|摔碎|碎裂|一劈为二|掰成|断开/, /裂|裂纹|劈开|破碎|断裂|折裂|掰开|炸|劈|裂痕|开裂/, 0.22],
      // —— 实体+动作 组合命中（超高权重：query说"牌匾裂开"且chunk也含"牌匾+裂纹"同时出现，给double boost）
      [/牌匾.*裂|裂.*牌匾|招牌.*裂|匾额.*裂/, /牌匾.*裂|裂.*牌匾|招牌.*裂|匾额.*裂|牌匾.*裂纹|裂纹.*牌匾/, 0.16],
      // —— 氛围/意象类
      [/光荣|荣耀|名声|声誉|鼎盛|辉煌|往昔|岁月/, /光荣|荣耀|辉煌|往昔|鼎盛|盛极|声誉|岁月|沧桑|旧事/, 0.10],
      // —— 手部动作（抚摸裂纹是牌匾裂开的经典衔接镜头）
      [/手指|抚摸|抚|触碰|摩挲|指尖|掌/, /手指|抚摸|抚|掌|手|触碰|摩挲|指尖|掌心|手背/, 0.14],
      // —— 室内场景（饭桌/吃饭等，便于区分室内外）
      [/饭桌|餐桌|吃饭|围坐|一桌|菜肴|碗筷|宴席|酒席/, /饭桌|餐桌|吃饭|菜肴|碗筷|围坐|一桌|茶桌|宴席|酒席|杯盏/, 0.10],
      // —— 人物主体类
      [/人物|老人|女子|男子|小孩|角色|身影|掌柜|伙计/, /人物|老人|女子|男子|小孩|身影|掌柜|伙计|佣人|书生/, 0.06],
      // —— 景别类
      [/特写|近景|中景|全景|远景|航拍/, /特写|近景|中景|全景|远景|航拍|大特写|极特写|大远景|推镜|拉镜/, 0.06],
    ];
    /** 关键词匹配加分：clamp 到 0.70（比原 0.60 抬高一点，让组合命中有叠加空间） */
    const keywordMatchBoost = (qText: string, descText: string, cEmotion: string, cShotType: string, cCharacters: string[] | undefined, cKeywords: string[] | undefined): number => {
      const q = qText || '';
      const cAll = [descText || '', cEmotion || '', cShotType || '', Array.isArray(cCharacters) ? cCharacters.join(' ') : '', Array.isArray(cKeywords) ? cKeywords.join(' ') : ''].join(' ');
      let bonus = 0;
      for (const [qr, cr, b] of KEYWORD_BOOST_PAIRS) {
        if (qr.test(q) && cr.test(cAll)) bonus += b;
      }
      return Math.min(bonus, 0.70);
    };

    /** 保护规则①：description 覆盖率 <30%，纯时间锚信号太弱，直接跳预选。
     *  ⚠️ 必须统计**原始 videoChunks** 的覆盖率，不能用上面补完后的 workingChunks：
     *     相邻描述继承会沿数组链式传播——只要池中存在 1 条描述，整池都会被填满，
     *     按 workingChunks 计算覆盖率恒为 100%，该保护规则将永远无法触发（实测原始 15% 被判成 100%，
     *     applied 仍为 true），与"覆盖率 <30% 跳预选"的契约矛盾。 */
    const withDesc = videoChunks.filter((c) => (c.description || '').trim().length > 0).length;
    if (withDesc / Math.max(1, M) < minDescCoverage) {
      AppLogger.info(LOG_TAGS.AI_AGENT,
        `[preselectTopK] ${opts?.logProjectId || ''} 切片描述覆盖率=${(withDesc / M * 100).toFixed(1)}% < ${minDescCoverage * 100}%，跳过预选（保留全集 M=${M}）`);
      // 跳过预选也返回原 videoChunks（不返回 workingChunks，避免下游感知"继承标记"）
      return fallback;
    }

    /** 动态 K：≥15 / ≥3.0N（KM 池子足够，且 daemon 对未入 perQueryTopK 的行级候选置强惩罚，
     *  召回需留安全余量；从 2.0 抬到 3.0，针对"弱文本 + 中弱时间"的切片短召回漏进 top-K）/ ≥12%M，
     *  三者取最大后夹到 [15, M] */
    let K = Math.max(15, Math.ceil(N * 3.0), Math.ceil(M * 0.12));
    K = Math.min(K, M);
    /** 小项目自动跳预选（放松阈值 + 绝对保护）：
     *  - K*1.5 ≥ M：比例上接近全集，剪了反而引入噪声（从1.2放宽到1.5，随 K 放大同步抬升，
     *   防止 K*3.0N 变大后大批中小项目被误推去"跳预选丢压缩"——仍保留预选的召回放大收益）
     *  - M ≤ 30：绝对小池，KM 算法 N³/M² 复杂度已很低，直接保留全集（防裁剪后只剩 24 个 seg 时硬被预选再砍）
     *  两条任一触发 → 跳预选 */
    if (K * 1.5 >= M || M <= 30) {
      return fallback;
    }

    /* -------------------- 步骤1：TF-IDF 语料建表（doc = query.text + query.visualIntent + chunk.description） -------------------- */
    const STOPWORDS = new Set<string>([
      '的','了','是','一','一个','我们','你们','他们','和','与','及','或','在','有','也','都','就','而','这','那','被','把','让','给','对','为','并','但','却','很','更','最','还','只','又','上','下','中','里','到','从','向','然后','接着','之后','before','after','with','without','this','that','these','those','the','a','an','and','or','is','are','was','were','of','to','in','on','for','with','by','as','at','it','its','be','been','being','have','has','had','do','does','did','will','would','could','should','may','might','can','not','no','yes','so','if','then','else','than','when','where','what','which','who','how','i','you','he','she','we','they','me','him','her','us','them','my','your','our','their',
    ]);
    const normalize = (raw: string): string[] => {
      if (!raw) return [];
      const s = String(raw).toLowerCase().replace(/[\s\u3000]+/g, ' ').trim();
      if (!s) return [];
      const tokens: string[] = [];
      /** 英文按单词切 */
      const en = s.match(/[a-z0-9]+/g) || [];
      for (const w of en) if (w.length >= 2 && !STOPWORDS.has(w)) tokens.push(w);
      /** 中文按字切（单字 + 相邻双字，中文 bag-of-characters 做相似度比单字鲁棒） */
      const zhSeg = Array.from(s.replace(/[a-z0-9\s\p{P}\p{S}]/gu, ''));
      for (let i = 0; i < zhSeg.length; i++) {
        const ch = zhSeg[i];
        if (!ch || STOPWORDS.has(ch)) continue;
        tokens.push(ch);
        if (i + 1 < zhSeg.length) {
          const bi = ch + zhSeg[i + 1];
          if (!STOPWORDS.has(bi)) tokens.push(`2:${bi}`);
        }
      }
      return tokens;
    };

    /** TF-IDF 建 D：docs = queries + workingChunks；每个 doc 记录 tf Map<tok, freq> */
    const docs: Array<{ id: string; isQuery: boolean; qIdx?: number; cIdx?: number; tf: Map<string, number>; norm?: number }> = [];
    const df = new Map<string, number>();
    const addDoc = (id: string, isQuery: boolean, text: string, qIdx?: number, cIdx?: number) => {
      const tokens = normalize(text);
      const tf = new Map<string, number>();
      const seen = new Set<string>();
      for (const t of tokens) {
        tf.set(t, (tf.get(t) || 0) + 1);
        if (!seen.has(t)) { seen.add(t); df.set(t, (df.get(t) || 0) + 1); }
      }
      docs.push({ id, isQuery, qIdx, cIdx, tf });
    };

    queries.forEach((q, i) => {
      const joined = [q.text || '', q.visualIntent || '', q.emotion || ''].filter(Boolean).join(' ');
      addDoc(`q_${i}`, true, joined, i, undefined);
    });
    workingChunks.forEach((c, i) => {
      const joined = [c.description || '', c.emotion || '', c.shotType || '', Array.isArray(c.characters) ? (c.characters as string[]).join(' ') : ''].filter(Boolean).join(' ');
      addDoc(`c_${i}`, false, joined, undefined, i);
    });

    const D = docs.length;
    const idf = (tok: string) => Math.log((D + 1) / ((df.get(tok) || 0) + 1)) + 1;
    /** 计算每个 doc 的 tf-idf 向量（稀疏 Map）+ L2 范数（供快速 cos） */
    for (const d of docs) {
      let nn = 0;
      d.tf.forEach((freq, tok) => {
        const w = freq * idf(tok);
        d.tf.set(tok, w);
        nn += w * w;
      });
      d.norm = Math.sqrt(nn) || 1;
    }
    /** 把 query docs / chunk docs 拆出来，避免循环里查 id */
    const qDocs = docs.filter((d) => d.isQuery);
    const cDocs = docs.filter((d) => !d.isQuery);
    /** 快速 cos 函数：两个稀疏向量只在 tok 交集上累加 Σw1·w2，然后 / (‖a‖·‖b‖) */
    const cosine = (a: Map<string, number>, aNorm: number, b: Map<string, number>, bNorm: number): number => {
      if (a.size === 0 || b.size === 0) return 0;
      /** 选择较小的那个迭代，减少查 Map 次数（纯小优化） */
      const [small, big] = a.size <= b.size ? [a, b] : [b, a];
      let dot = 0;
      small.forEach((w, tok) => {
        const bw = big.get(tok);
        if (bw !== undefined) dot += w * bw;
      });
      const d = aNorm * bNorm;
      return d <= 0 ? 0 : Math.max(0, Math.min(1, dot / d));
    };

    /* -------------------- 步骤2：视频时间线，补全 query.startMs（若前端没填 → 按 N 线性均分视频尾部） -------------------- */
    const videoEndMs = Math.max(...workingChunks.map((c) => Number(c.endMs) || 0), 0);
    const videoStartMs = Math.min(...workingChunks.map((c) => Number(c.startMs) || 0), 0);
    const videoSpanMs = Math.max(1, videoEndMs - videoStartMs);
    const queryStartMs = queries.map((q, i) => {
      if (q.startMs && q.startMs > 0) return q.startMs;
      /** 线性占位：按 q 在 queries 中的比例分到 [0, videoSpanMs] */
      const ratio = queries.length <= 1 ? 0 : i / (queries.length - 1);
      return videoStartMs + ratio * videoSpanMs;
    });
    const queryDurMs = queries.map((q) => Math.max(2000, q.audioDurationMs || 0, q.durationMs || 0));

    /** Sigmoid 把任意实数压到 [0,1]，用于把 time_span 的重叠分数归一成相似度 */
    const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

    /* -------------------- 步骤3：对每个 query 算 top-K 候选 -------------------- */
    const perQueryTopK: Record<string, string[]> = {};
    const perQueryTopKSet: Record<string, Set<string>> = {};
    const unionIds = new Set<string>();
    /** 用于"质量保护② 候选多样性不足自动扩张"：每个 query 我们先取排序全表，后面按需扩张 K' */
    const perQueryScored: Array<Array<{ cid: string; score: number; midMs: number; sText: number }>> = [];

    for (let qi = 0; qi < qDocs.length; qi++) {
      const q = queries[qi];
      const qd = qDocs[qi];
      const qSt = queryStartMs[qi];
      const qDur = queryDurMs[qi];
      const qEnd = qSt + qDur;
      const qNorm = qd.norm || 1;
      const qTf = qd.tf;
      // 把 query 的文本（含 visualIntent/emotion）拼一次给关键词 boost 用，避免循环内重复拼
      const qBoostText = [q.text || '', q.visualIntent || '', q.emotion || ''].filter(Boolean).join(' ');

      const scored: Array<{ cid: string; score: number; midMs: number; sText: number }> = [];
      for (let ci = 0; ci < cDocs.length; ci++) {
        const cd = cDocs[ci];
        const chunk = workingChunks[ci];
        const cSt = Number(chunk.startMs) || 0;
        const cEnd = Number(chunk.endMs) || cSt;
        const cMid = (cSt + cEnd) / 2;

        /** (A) 文本语义分（TF-IDF cosine） */
        let sText = cosine(qTf, qNorm, cd.tf, cd.norm || 1);
        /** (A+) 关键词实体匹配 boost：叠加到 sText，裁剪到 1.0 */
        const kwBonus = keywordMatchBoost(
          qBoostText,
          chunk.description || '',
          chunk.emotion || '',
          chunk.shotType || '',
          (chunk as any).characters,
          (chunk as any).keywords,
        );
        if (kwBonus > 0) sText = Math.min(1.0, sText + kwBonus);

        /** (B) 时间锚分：与 daemon 侧时空窗口对齐（关键修复）
         *  🔧 此前用「query 自身跨度 [qSt, qEnd]」算重叠/gap，而 daemon(`timeline_solver.py`) 的真实
         *     匹配窗口是 [qSt−WINDOW_LEAD_MS, qEnd+WINDOW_TAIL_MS]（前探 30s / 后延 60s，窗外才置
         *     WINDOW_PENALTY）。两者口径不一致 → 「落在 daemon 窗口内、却在预选跨度外」的切片
         *     sTime≈0 被挤出 Top-K，而 KM 随后正当地选中它（它在窗口内不受罚）→ 审计记成 miss。
         *     实测该错配导致 Top-K 命中率仅 70.65%（27/92 最终匹配落在预选集之外）。
         *     这里把时间分改为对齐 daemon 窗口，消除"预选把合法候选提前砍掉"的漏召回。 */
        const wSt = qSt - PRESELECT_WINDOW_LEAD_MS;
        const wEnd = qEnd + PRESELECT_WINDOW_TAIL_MS;
        const overlap = Math.max(0, Math.min(wEnd, cEnd) - Math.max(wSt, cSt));
        const gap = Math.max(0, cSt - wEnd, wSt - cEnd);
        /** 0.002 = 500ms 重叠 bonus 到 0.73 sigmoid 平台，1s gap 回到 ~0.12，足够拉开分布 */
        const sTime = sigmoid(0.002 * (overlap - gap));

        const score = alpha * sText + beta * sTime;
        scored.push({ cid: chunk.id, score, midMs: cMid, sText });
      }
      scored.sort((a, b) => b.score - a.score);
      perQueryScored.push(scored);

      /** 先选出 K 个，然后执行"质量保护② 多样性扩张"：
       *  如果 topK 的 min/max midMs 跨度 < 3·qDur，说明候选挤在同一小区间里（极可能是文本语义偶然高分），
       *  往 K+1 一直补，直到跨度达标或补到 2K（最多翻一倍，防止过扩张）。
       *  🎯 2026-09-20 时间局部化：扩张只允许在收敛窗（[wSt−CONV, wEnd+CONV]）内/窗边补，越界立即停止，
       *  杜绝"跨度不足→摊到全片"（此前候选池时间跨度中位数 3811s，致 daemon 只能在线乱序池里选→时间倒走）。 */
      const qConvSt = Math.max(0, qSt - PRESELECT_WINDOW_LEAD_MS - CONV_MARGIN_MS);
      const qConvEnd = qSt + qDur + PRESELECT_WINDOW_TAIL_MS + CONV_MARGIN_MS;
      let kk = K;
      if (scored.length > K) {
        const minSpanMs = 3 * qDur;
        let lo = scored[0].midMs, hi = scored[0].midMs;
        for (let i = 0; i < K; i++) { lo = Math.min(lo, scored[i].midMs); hi = Math.max(hi, scored[i].midMs); }
        let i = K;
        while (i < scored.length && i < 2 * K && (hi - lo) < minSpanMs) {
          if (scored[i].midMs < qConvSt || scored[i].midMs > qConvEnd) break; // 越出收敛窗 → 停止扩张
          lo = Math.min(lo, scored[i].midMs); hi = Math.max(hi, scored[i].midMs);
          i++;
        }
        kk = i;
      }
      const top = scored.slice(0, Math.min(kk, scored.length));
      const ids = top.map((s) => s.cid);
      perQueryTopK[q.shotId] = ids;
      perQueryTopKSet[q.shotId] = new Set(ids);
      for (const cid of ids) unionIds.add(cid);

      /** 🎯 2026-09-19 窗口保底（修复 Top-K 命中率，方案：窗口并入候选）：把落在该 query 段落窗口内的切片
       *  并入 perQueryTopK。根因：per-query top-K 是独立打分排名，弱文本真匹配常被时间窗内大量"看似相关"的
       *  干扰切片挤出 K 名以外；而 daemon 白名单档位 on 会对外候选切片置 5.0 强罚（CAND_WL_PENALTY_HARD），
       *  真匹配被硬挡在 KM 之外（实测 N=83/M=1509：K 166→249 命中仅 46.22%→61.67%）。但 daemon 窗外切片
       *  同样被 WINDOW_PENALTY 5.0 压制，KM 真正能选中的"合规切片"几乎都在段落窗口内；故把窗口内切片全部
       *  并入候选，即让 KM 窗口内选中的任何切片必入白名单，命中率可趋近 100%。
       *  窗口口径与 daemon 硬边界 attachQueryWindow 同源：[start−LEAD, start+dur+TAIL]（此处用 qSt/qDur，
       *  qDur=max(2s,audio,dur) 只宽不窄，保证 daemon 窗口 ⊆ 此保底窗）。收窄职责回归窗口硬边界，
       *  不额外膨胀并集（窗口内切片本就是 KM 实际取料范围）。 */
      const qWinSt = Math.max(0, qSt - PRESELECT_WINDOW_LEAD_MS);
      const qWinEnd = qSt + qDur + PRESELECT_WINDOW_TAIL_MS;
      const qSet = perQueryTopKSet[q.shotId] as Set<string>;
      for (let si = 0; si < scored.length; si++) {
        const sc = scored[si];
        if (sc.midMs >= qWinSt && sc.midMs <= qWinEnd && !qSet.has(sc.cid)) {
          qSet.add(sc.cid);
          perQueryTopK[q.shotId].push(sc.cid);
          unionIds.add(sc.cid);
        }
      }

      /** 🎯 2026-09-20 时间局部化·跨窗高语义兜底：收敛后仍保留少量"窗强语义但跨窗"候选，
       *  防止时间收敛过度牺牲语义召回（平衡式：主体收在合法窗，兜底留跨窗强相关）。
       *  只取窗外收敛区（[qWinSt,qWinEnd] 之外）且 sText≥0.55 的高相关切片，上限 spillCap。 */
      const spillCap = Math.min(Math.ceil(K * 0.2), 10);
      let spillCnt = 0;
      for (const sc of scored) {
        if (spillCnt >= spillCap) break;
        if (qSet.has(sc.cid)) continue;
        if (sc.midMs >= qWinSt && sc.midMs <= qWinEnd) continue; // 窗内已并，跳过
        if ((sc.sText ?? 0) < 0.55) continue;                       // 语义太弱，不兜底
        qSet.add(sc.cid);
        perQueryTopK[q.shotId].push(sc.cid);
        unionIds.add(sc.cid);
        spillCnt++;
      }
    }

    /* -------------------- 步骤4：质量保护③ 候选并集 ≥ 2N，不足时按"未入并集的 chunk 里平均分最高的"补齐 -------------------- */
    const minUnion = Math.min(M, Math.max(2 * N, Math.ceil(M * 0.1)));
    if (unionIds.size < minUnion) {
      /** 补池策略：对每个还没入 unionIds 的 chunk，取它在任意 query 中的最高得分，按这个分降序取够数 */
      const bestByChunk = new Map<string, number>();
      for (let qi = 0; qi < perQueryScored.length; qi++) {
        for (const s of perQueryScored[qi]) {
          if (unionIds.has(s.cid)) continue;
          bestByChunk.set(s.cid, Math.max(bestByChunk.get(s.cid) || 0, s.score));
        }
      }
      const arr = Array.from(bestByChunk.entries()).sort((a, b) => b[1] - a[1]);
      for (const [cid] of arr) {
        if (unionIds.size >= minUnion) break;
        unionIds.add(cid);
      }
    }

    /* -------------------- 步骤4.5（🎬 批1 N3 补充）：场景组保底入池 -------------------- */
    // 带 sceneGroup 的 query 若其同组切片因"弱文本 + 远时序"被 Top-K 整体剔除，
    // 则 daemon 侧的窗口豁免 / 场景加成将无从触发（候选池里根本没有目标切片）。
    // 这里把同组切片按时间均匀抽样并入 perQueryTopK 与 unionIds（上限 MAX_SCENE_EXTRA），
    // 与 daemon 端 R2-3 窗口豁免配合，让目标场景切片可被 KM 选中。
    // 🎯 2026-09-20 时间局部化：上限 24→8，且抽样优先收敛窗内同组切片，窗外同组仅在窗内不足时补足，
    //   不再全片均匀散布（此前把散布全片的同场景切片并入，加剧候选池跨全片打乱）。
    const MAX_SCENE_EXTRA = 8;
    let scenePoolAdded = 0;
    for (const q of queries) {
      const qsg = String(q.sceneGroup || '').trim();
      if (!qsg) continue;
      const sid = String(q.shotId);
      const candList = perQueryTopK[sid] || [];
      const candSet = perQueryTopKSet[sid] || new Set<string>();
      if (!perQueryTopK[sid]) perQueryTopK[sid] = candList;
      if (!perQueryTopKSet[sid]) perQueryTopKSet[sid] = candSet;
      /** 该 query 收敛窗（与 daemon 合法窗一致，供"窗内优先抽样"） */
      const qSt = Number(q.startMs) || 0;
      const qSirDurMs = Math.max(2000, Number(q.audioDurationMs) || 0, Number(q.durationMs) || 0);
      const gWinSt = Math.max(0, qSt - PRESELECT_WINDOW_LEAD_MS - CONV_MARGIN_MS);
      const gWinEnd = qSt + qSirDurMs + PRESELECT_WINDOW_TAIL_MS + CONV_MARGIN_MS;
      /** 按时间序收集同组切片 id（workingChunks 已按时间轴排序），区分离窗内/窗外 */
      const sceneIdsIn: string[] = [];
      const sceneIdsOut: string[] = [];
      for (const c of workingChunks) {
        if (candSet.has(String(c.id))) continue;   // 已入选的跳过，不重复
        const cs = String(c.scene || '').trim() || extractSceneFromDescription(String(c.description || ''));
        if (!cs || matchSceneGroup(cs) !== qsg) continue;
        const cMid = (Number(c.startMs) + Number(c.endMs)) / 2;
        (cMid >= gWinSt && cMid <= gWinEnd ? sceneIdsIn : sceneIdsOut).push(String(c.id));
      }
      if (sceneIdsIn.length === 0 && sceneIdsOut.length === 0) continue;
      /** 优先窗内，窗外仅在窗内不足时补足，本 query 合计 ≤ MAX_SCENE_EXTRA（收敛优先，防全片散布）。
       *  用局部计数 picked 限制本 query 抽样量；scenePoolAdded 仍是全局累加（供日志） */
      let picked = 0;
      const pickFrom = (pool: string[]): void => {
        const step = Math.max(1, Math.ceil(pool.length / MAX_SCENE_EXTRA));
        for (let i = 0; i < pool.length && picked < MAX_SCENE_EXTRA; i += step) {
          const cid = pool[i];
          if (candSet.has(cid)) continue;
          candSet.add(cid);
          candList.push(cid);
          unionIds.add(cid);
          picked++;
          scenePoolAdded++;
          if (picked >= MAX_SCENE_EXTRA) break;
        }
      };
      pickFrom(sceneIdsIn);
      pickFrom(sceneIdsOut);
    }
    if (scenePoolAdded > 0) {
      AppLogger.info(LOG_TAGS.AI_AGENT,
        `[preselectTopK] ${opts?.logProjectId || ''} 批1 场景组保底入池：${scenePoolAdded} 个同组切片并入候选集（让 KM 场景命中可跨窗取到散布切片）`);
    }

    /* -------------------- 步骤4.75（🎯 2026-09-20 时间局部化·顺续化）：perQueryTopK 按源时间单调排序 -------------------- */
    // 此前 perQueryTopK 的顺序 = score 降序 + K 扩张 + 窗内追加 + 场景组追加，是非源时间序；
    // daemon 白名单档位 on 只在 perQueryTopK 内选，候选乱序直接传导为成片时间倒走（36 段）。
    // 这里对每个 query 的候选按切片 midMs 升序 sort，让 daemon 顺着源时间推进。
    // filteredChunks 本已按 workingChunks(startMs 序) 过滤，不受影响；candSet 是集合对顺序不敏感。
    {
      const idToMidMs = new Map<string, number>();
      for (const c of workingChunks) {
        idToMidMs.set(String(c.id), (Number(c.startMs) + Number(c.endMs)) / 2 || 0);
      }
      for (const sid of Object.keys(perQueryTopK)) {
        const arr = perQueryTopK[sid];
        if (arr.length > 1) arr.sort((a, b) => (idToMidMs.get(String(a)) ?? 0) - (idToMidMs.get(String(b)) ?? 0));
      }
    }

    /* -------------------- 步骤5：按 chunk.id∈unionIds 构造 filteredChunks，顺序与原 videoChunks 一致（daemon 侧期望按 startMs 顺序） -------------------- */
    // 注意：这里使用 workingChunks（带继承描述副本），目的是让后续 Python KM 的文本语义分支也能
    //       直接用到继承后的描述。然后剥离临时的 _inheritedDesc 字段，避免下游序列化/打印噪音。
    const filteredChunks = workingChunks
      .filter((c: any) => unionIds.has(c.id))
      .map((c: any) => {
        if (!('_inheritedDesc' in c)) return c;
        const { _inheritedDesc, ...rest } = c;
        void _inheritedDesc;
        return rest;
      });
    const M1 = filteredChunks.length;

    AppLogger.info(LOG_TAGS.AI_AGENT,
      `[preselectTopK] ${opts?.logProjectId || ''} Top-K 预选 applied=true：N=${N}，动态 K=${K}，切片池 ${M} → ${M1}（压缩 ${M > 0 ? (100 - M1 / M * 100).toFixed(1) : '0.0'}%），并集≥2N(${minUnion})=${unionIds.size >= minUnion}`);

    return { filteredChunks, perQueryTopK, K, M0: M, M1, applied: true };
  }

  /**
   * 审计工具：对比"KM 最终匹配结果"与"预选可用池"，输出真实覆盖率。
   *  🎯 2026-09-19 修正口径：主指标对齐 daemon 实际行为——**并集口径**（该匹配是否被预选从池中删除）。
   *    根因：daemon 白名单惩罚对 scene/entity/段域豁免格不生效（not scene_hit and not _ent_hit and not _sb_hit），
   *    这类跨窗切片即使不在 per-query top-K 白名单里也能被 KM 选中（豁免型命中，本项目场景组规模大 → 实测 1281 片入池）。
   *    旧 per-query 白名单口径把这些合法豁免命中误报为 miss（真实项目 61.67% 虚降）。
   *    新口径：命中 = 白名单命中 OR 并集命中（re-end co 预选未删除的候选即不该算失败），与 realdata 测试的 rateUnion 一致。
   *    白名单命中率保留为次级监控（提示候选收窄是否过度），不再触发 warn。
   *  单项目并集命中率 < 0.95 才打 warn，提示预选误删了可匹配候选。
   * @param perQueryTopK preselectTopK 返回的 perQueryTopK
   * @param matches KM 结果 matches 数组（必须带 shotId + mediaId/chunkId）
   * @param projectId 可选，日志里定位项目
   * @param unionChunkIds 可选，预选并集（filteredChunks 的 id 全集）；缺省时降级为纯白名单口径（兼容单测）
   */
  static auditPreselectTopK(
    perQueryTopK: Record<string, string[]>,
    matches: any[],
    projectId?: string,
    unionChunkIds?: Set<string>,
  ): { total: number; hit: number; hitRate: number; whitelistHit: number; whitelistRate: number } {
    if (!matches || matches.length === 0) return { total: 0, hit: 0, hitRate: 1 as number, whitelistHit: 0, whitelistRate: 1 as number };
    let total = 0, hit = 0, wlHit = 0;
    for (const m of matches) {
      // ✅ 身份键统一：MatchResult 主键为 id（出生处 seg_N 全局唯一），审计也一律读 id
      const sid = String(m.id || '');
      const cid = String(m.mediaId || m.chunkId || '');
      const cand = perQueryTopK[sid];
      /** keepOriginalAudio 的原声定位匹配或纯未命中（cid 空）不在预选审计范围内，跳过 */
      if (!sid || !cid || !cand || m.keepOriginalAudio === true) continue;
      total++;
      const inWhitelist = cand.includes(cid);
      // 并集口径：预选未从池中删除该候选（白名单命中 或 靠 daemon 豁免通道救回）都算"预选未误杀"
      const inUnion = unionChunkIds ? unionChunkIds.has(cid) : inWhitelist;
      if (inWhitelist) wlHit++;
      if (inUnion) hit++;
    }
    const hitRate = total === 0 ? 1 : hit / total;
    const wlRate = total === 0 ? 1 : wlHit / total;
    /** 新增次级拆解：白名单命中率——提示候选收窄是否过度（不够 95% 时说明候选白名单在压缩，需关注但非预选失败） */
    const extra = unionChunkIds
      ? `（白名单命中=${(wlRate * 100).toFixed(2)}%，${wlHit}/${total}）`
      : '';
    if (total > 0 && hitRate < 0.95) {
      AppLogger.warn(LOG_TAGS.AI_AGENT,
        `[preselectTopK/audit] ${projectId || ''} Top-K 命中率=${(hitRate * 100).toFixed(2)}% < 95%，共 ${total} 条语义匹配，其中 ${total - hit} 条最终匹配未进入预选 Top-K。建议增大 K 或调低 minDescCoverage${extra}`);
    } else if (total > 0) {
      AppLogger.info(LOG_TAGS.AI_AGENT,
        `[preselectTopK/audit] ${projectId || ''} Top-K 命中率=${(hitRate * 100).toFixed(2)}%（${hit}/${total}），预选质量符合预期${extra}`);
    }
    return { total, hit, hitRate, whitelistHit: wlHit, whitelistRate: wlRate };
  }

  /**
   * 🛡️ timeline 有效性防御（出生处共用出口）：daemon KM 返回的历史脏数据存在"两端相等/逆序"形态
   * （如 seg_7 的 startMs==endMs=32544.9），`|| 0` / `??` 链只挡 nullish、挡不住非空无效值，
   * 原样透传落库 → 剪映装配 start<end 校验 fail-fast 炸整次导出。
   * 三级取值：timeline 有限且 start<end → 原样用之；否则切片窗口合法 → 回退切片边界；
   * 均无效 → (0, 0)，交给消费端 unmatched 兜底判定。
   */
  static resolveTimelineWindow(
    timelineStartMs: unknown,
    timelineEndMs: unknown,
    chunkStartMs: unknown,
    chunkEndMs: unknown,
  ): { startMs: number; endMs: number } | null {
    const tStart = Number(timelineStartMs);
    const tEnd = Number(timelineEndMs);
    if (Number.isFinite(tStart) && Number.isFinite(tEnd) && tStart < tEnd) {
      return { startMs: tStart, endMs: tEnd };
    }
    const cStart = Number(chunkStartMs);
    const cEnd = Number(chunkEndMs);
    if (Number.isFinite(cStart) && Number.isFinite(cEnd) && cStart < cEnd) {
      return { startMs: cStart, endMs: cEnd };
    }
    /** 🛑 2026-09-05 B3：timeline 与切片窗口均无效 → 返回 null（调用方 fail-fast 抛错暴露），
     *  不再伪装合法 (0,0)——(0,0) 会把"切片坐标被污染"的坏数据静默带进导出/预览。 */
    return null;
  }

  /**
   * 🔧 字幕纯净（第五轮）：剥离 buildMatchQueries 为语义匹配拼接到 text 尾部的 visualIntent 后缀。
   *
   * 拼接契约：query.text = `${台词正文} | ${visualIntent}`（景别/情绪/画面描述，供 TF-IDF/KM 文本匹配吃信号）。
   * matchResult.text 是面向字幕 / 卡片 / 导出的展示字段，后缀在匹配完成后即失去价值，
   * 原样透传会让"【中景】解说词：过渡叙事，情绪基调：悲伤沉重"整串进原声字幕（用户反馈）。
   * 精确按尾缀匹配剥离（仅当 text 以 " | ${visualIntent}" 结尾才裁），正文自含 "|" 不受影响。
   */
  static stripVisualIntentSuffix(text: string, visualIntent?: string): string {
    const raw = String(text || '');
    const vi = String(visualIntent || '').trim();
    if (!vi || !raw) return raw;
    const suffix = ` | ${vi}`;
    return raw.endsWith(suffix) ? raw.slice(0, raw.length - suffix.length) : raw;
  }

  /**
   * 函数级中文注释：把「匹配单位级命中结果」组装成「碎片级 matchResult」（结果回填的唯一出口）。
   *
   * sentence 档下 KM 以匹配单位（完整句）为粒度返回，一条单位结果要展开回该单位覆盖的每一个碎片，
   * 让下游（TTS / 字幕 / 卡片 / 导出）拿到的 matchResults 数量与结构恒等于段落数：
   *  - 身份/文本/时长取【碎片自身】（q.shotId = 碎片主键，text = 碎片正文，audioDurationMs = 碎片 TTS 时长）；
   *  - 画面归属（切片 / timeline / 置信度 / 变速）继承【单位级命中结果】——整句共用同一画面窗口。
   *
   * 🎵 碎片级 audioDurationMs 保真：单位结果携带的是"完整句总时长"（KM 时长代价口径），
   *   碎片必须保留自身 TTS 时长，否则字幕/导出侧按整句时长算变速会失真。
   *
   * @param shotQuery 碎片级 query（由 _buildShotLevelQueries 产出，含碎片自身 text/audioDurationMs/原声标记）
   * @param unitResult 该碎片所属匹配单位的 KM 命中结果（或原声定位结果）
   * @returns 碎片级 matchResult
   */
  private static buildMatchResultFromUnit(
    shotQuery: { shotId: string; text: string; audioDurationMs: number; keepOriginalAudio?: boolean; visualIntent?: string },
    unitResult: any,
  ): any {
    return SemanticAnalyzeStrategy.buildMatchResult(
      shotQuery,
      { ...unitResult, audioDurationMs: shotQuery.audioDurationMs },
      shotQuery.keepOriginalAudio === true,
    );
  }

  /**
   * 组装单条匹配结果（原声定位 / 语义匹配 / 未匹配 共用出口）
   * @param q query 段落（含 shotId/text/audioDurationMs/keepOriginalAudio/visualIntent）
   * @param matched KM 匹配项或原声定位结果；null 表示未匹配
   * @param isOriginal 是否为已定位的原声段落（原声段落自带原声轨，固定高置信）
   */
  static buildMatchResult(
    q: { shotId: string; text: string; audioDurationMs: number; keepOriginalAudio?: boolean; visualIntent?: string; matchUnitId?: string },
    matched: any | null,
    isOriginal: boolean,
  ): any {
    if (matched) {
      /** 🔧 P1-5 数据卫生：chunkData 透传前端/落库前剥离 CLIP 大字段（clipZhEmbedding/visionEmbedding/colorHistogram
       *  可达 512 维浮点数组），否则 matchResults 被 embedding 塞满、快照 JSON 爆炸。
       *  embedding 仅 KM 图像编码缓存需要（存于 video_chunk_parts，不随 matchResult 下发）。 */
      const chunkData = matched.chunkData;
      const lightChunkData = chunkData && typeof chunkData === 'object'
        ? (() => {
            const { clipZhEmbedding, visionEmbedding, colorHistogram, ...rest } = chunkData;
            return rest;
          })()
        : chunkData;
      /** 🛡️ timeline 有效性校验：daemon 坏数据（两端相等/逆序）挡在落库前，无效时回退切片自身窗口（合法时）；
       *  🛑 B3：timeline 与切片窗口均无效 → 数据被污染，fail-fast 抛错暴露，不再伪装 0/0。 */
      const timeline = SemanticAnalyzeStrategy.resolveTimelineWindow(
        matched.videoTimelineStartMs,
        matched.videoTimelineEndMs,
        lightChunkData?.startMs,
        lightChunkData?.endMs,
      );
      if (!timeline) {
        throw new Error(
          `镜头匹配数据异常：切片 ${matched.chunkId || matched.mediaId || '(无 id)'} 的 videoTimeline 与切片窗口均无效，` +
          '请清空切片缓存后重跑（脏切片坐标已 fail-fast 阻止落库）',
        );
      }
      return {
        /** ✅ 身份键统一：id 出生处即取段落唯一主键（buildMatchQueries 中 shotId 已收敛为 s.id），
         *  消费端一律读 id；shotId 保留同值兼容历史消费点。 */
        id: q.shotId,
        shotId: q.shotId,
        /** 🔧 字幕纯净（第五轮）：出生处剥离 visualIntent 后缀，matchResult.text 只保留台词/解说正文 */
        text: SemanticAnalyzeStrategy.stripVisualIntentSuffix(q.text, q.visualIntent),
        keepOriginalAudio: isOriginal,
        mediaType: 'video_chunk' as const,
        mediaId: matched.chunkId || matched.mediaId || '',
        score: isOriginal ? 0.95 : (matched.confidence || 0),
        thumbnail: matched.coverPath || '',
        chunkData: lightChunkData,
        audioDurationMs: matched.audioDurationMs || q.audioDurationMs,
        videoTimelineStartMs: timeline.startMs,
        videoTimelineEndMs: timeline.endMs,
        /** 🎙️ 原声段恒不变速（第五轮）：原声段时长=ASR 台词真实时间窗，按 TTS 时长凑变速必然忽快忽慢；
         *  ASR 锚定+文本定位均失败而回退混入 KM 的原声段同样强制 1.0（用户反馈：原声为什么还要变速） */
        appliedSpeedFactor: isOriginal ? 1.0 : (matched.appliedSpeedFactor || 1.0),
        confirmed: isOriginal ? true : (matched.confidence || 0) >= 0.88,
        /** 🎯 候选不足降级警示（2026-09-06）：daemon 候选不足降级到全池时透出，前端据此显示"兜底匹配"警示 */
        degraded: matched.degraded === true,
        /** 🎯 匹配单位 id（sentence 档 2026-09-18）：query 折叠时写入，随 matchResult 落库供按完整句溯源；
         *  legacy 档 query 无该字段 ⇒ 不写出，产物字段集与现状一致。 */
        ...(typeof q.matchUnitId === 'string' && q.matchUnitId.trim() ? { matchUnitId: String(q.matchUnitId).trim() } : {}),
      };
    }
    return {
      /** ✅ 身份键统一：id 出生处即取段落唯一主键（与上方命中分支同源） */
      id: q.shotId,
      shotId: q.shotId,
      text: SemanticAnalyzeStrategy.stripVisualIntentSuffix(q.text, q.visualIntent),
      keepOriginalAudio: isOriginal,
      mediaType: 'video_chunk' as const,
      mediaId: '',
      score: 0,
      thumbnail: '',
      chunkData: null,
      audioDurationMs: q.audioDurationMs,
      videoTimelineStartMs: 0,
      videoTimelineEndMs: 0,
      appliedSpeedFactor: 1.0,
      confirmed: false,
      /** 未匹配（非降级）不标警示 */
      degraded: false,
      /** 🎯 匹配单位 id（sentence 档 2026-09-18）：未匹配也透传，保证整份 matchResults 字段集一致可溯源 */
      ...(typeof q.matchUnitId === 'string' && q.matchUnitId.trim() ? { matchUnitId: String(q.matchUnitId).trim() } : {}),
    };
  }
}
