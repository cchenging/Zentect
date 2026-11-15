/**
 * 风格包（Style Pack）契约层 SSOT
 *
 * 三层结构：
 *   内容层（讲什么：猎奇度 / 锚点 / 反差）—— 由既有 PipelineParams 与剧情大纲承担；
 *   人格层（谁在说：东北大姐 / 街头大爷 / 动物世界旁白）—— 本文件的 persona；
 *   浓度（方言 × 抽象 × 猎奇指数 0~2）—— 本文件的 level。
 *
 * 红线：人格与浓度只重写「语体」，叙事结构仍由 SCRIPT_STYLES 六种结构预设决定；
 *       换包只重写文案，不重跑抽帧 / ASR / 人脸识别。
 */

/** 人格层三档取值元组（前端按钮顺序与后端查表共用，禁止在别处复写字面量） */
export const STYLE_PERSONA_VALUES = ['dongbei', 'jietou', 'animal'] as const;
/** 人格层三档联合类型 */
export type StylePersona = (typeof STYLE_PERSONA_VALUES)[number];

/** 浓度三档取值元组：0=稳 / 1=正常 / 2=拉满 */
export const STYLE_PACK_LEVEL_VALUES = [0, 1, 2] as const;
/** 浓度三档联合类型 */
export type StylePackLevel = (typeof STYLE_PACK_LEVEL_VALUES)[number];

/** 浓度三档展示名（下标即 level） */
export const STYLE_PACK_LEVEL_LABELS = ['稳', '正常', '拉满'] as const;

/** 风格包：人格 × 浓度（可持久化，随项目 metadata 落盘） */
export interface StylePack {
  persona: StylePersona;
  level: StylePackLevel;
}

/** 新建项目的默认包：东北大姐 · 正常（与原型默认一致） */
export const DEFAULT_STYLE_PACK: StylePack = { persona: 'dongbei', level: 1 };

/**
 * 人格 → Edge 推荐音色（第二增量：配音层跟随风格包）。
 * 只有 Edge 提供东北女声 zh-CN-liaoning-XiaobeiNeural，因此仅该引擎参与「跟随」；
 * 豆包 / Kokoro 无对应方言音色，保持用户手选值不自动改写。
 */
export const STYLE_PERSONA_EDGE_VOICE: Record<StylePersona, string> = {
  dongbei: 'zh-CN-liaoning-XiaobeiNeural',
  jietou: 'zh-CN-YunjianNeural',
  animal: 'zh-CN-YunyangNeural',
};

/** 句尾停顿可调区间（ms）：0=不留气口，上限 400 防止段落间明显断裂 */
export const TTS_PAUSE_MIN_MS = 0;
export const TTS_PAUSE_MAX_MS = 400;

/**
 * 句尾停顿默认值策略（唯一真源）：
 *   人格基准（谁在说决定语流密度）+ 浓度微调（稳=多留白 / 拉满=气口更紧）。
 * 全局兜底 DEFAULT_TTS_PAUSE_MS 恒等于「默认包（东北大姐·正常）」的解析值，
 * 这样旧工程（无 pauseMs 字段）回填兜底值与解析值一致，不会因新增策略产生指纹漂移。
 */
export const STYLE_PERSONA_BASE_PAUSE_MS: Record<StylePersona, number> = {
  dongbei: 180, // 唠嗑腔，句中已自带口语拖音，句尾不必再拖
  jietou: 140, // 吆喝短句快切，气口要短
  animal: 280, // 纪录片旁白，留白是节奏的一部分
};

/** 浓度对基准的偏移（下标 = level：稳 +40 / 正常 0 / 拉满 -40） */
export const STYLE_PACK_LEVEL_PAUSE_DELTA = [40, 0, -40] as const;

/** 全局兜底：无风格包 / 非法值时使用（= 东北大姐·正常 的解析值 180ms） */
export const DEFAULT_TTS_PAUSE_MS = STYLE_PERSONA_BASE_PAUSE_MS.dongbei;

/** 归一化 + 区间收敛：所有写入 pauseMs 的入口统一走这里 */
export function clampPauseMs(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_TTS_PAUSE_MS;
  return Math.min(TTS_PAUSE_MAX_MS, Math.max(TTS_PAUSE_MIN_MS, Math.round(num)));
}

/** 按风格包解析默认句尾停顿：人格基准 + 浓度偏移，结果再过区间收敛 */
export function resolveStylePackPauseMs(pack: StylePack | null | undefined): number {
  const normalized = normalizeStylePack(pack);
  const base = STYLE_PERSONA_BASE_PAUSE_MS[normalized.persona];
  const delta = STYLE_PACK_LEVEL_PAUSE_DELTA[normalized.level];
  return clampPauseMs(base + delta);
}

/**
 * 字幕排版随浓度派生（第三增量：成片层）。
 * 只由浓度决定：稳=收着走（字号略小、断句少、描边细）；拉满=顶着走（字号更大、强断句、描边粗）。
 * 该表只给「倍率/偏移」，实际数值叠加在用户全局 subtitleStyle 之上，不覆盖用户配置。
 */
export interface StylePackSubtitleTuning {
  /** 字号倍率（同时作用于竖屏 fontSize 与横屏 fontSizeLandscape） */
  fontSizeScale: number;
  /** 描边宽度倍率 */
  strokeWidthScale: number;
  /** 单行等效宽度偏移（正数=少断行更连贯，负数=强断句更冲） */
  lineWidthDelta: number;
}

/** 浓度 → 字幕排版派生表（下标 = level） */
export const STYLE_PACK_LEVEL_SUBTITLE_TUNING: readonly StylePackSubtitleTuning[] = [
  { fontSizeScale: 0.94, strokeWidthScale: 0.9, lineWidthDelta: 3 }, // 稳
  { fontSizeScale: 1, strokeWidthScale: 1, lineWidthDelta: 0 }, // 正常
  { fontSizeScale: 1.08, strokeWidthScale: 1.25, lineWidthDelta: -3 }, // 拉满
] as const;

/** 按风格包解析字幕排版派生（当前只跟浓度，人格保留给后续扩展） */
export function resolveStylePackSubtitleTuning(pack: StylePack | null | undefined): StylePackSubtitleTuning {
  const normalized = normalizeStylePack(pack);
  return STYLE_PACK_LEVEL_SUBTITLE_TUNING[normalized.level];
}

/** 派生是否为单位变换（正常浓度）：单位变换不写任何额外字段，保持旧工程导出结果逐字节不变 */
export function isIdentitySubtitleTuning(tuning: StylePackSubtitleTuning): boolean {
  return tuning.fontSizeScale === 1 && tuning.strokeWidthScale === 1 && tuning.lineWidthDelta === 0;
}

/**
 * 人格 → BGM 情绪倾向（第三增量：成片听觉层）。
 * 只作为「选曲意图」的偏好注入 LLM，并在步骤5 UI 提示；
 * 不锁定用户手选 BGM，也不改写已选曲目。
 */
export interface StylePersonaBgmProfile {
  /** 注入 LLM 的人格选曲说明 */
  moodHint: string;
  /** 偏好情绪标签（给 LLM 参考，不强制） */
  moodTags: readonly string[];
  /** 建议 BPM 区间（LLM 可按文案微调） */
  bpmRange: readonly [number, number];
}

/** 人格 → BGM 倾向表 */
export const STYLE_PERSONA_BGM_PROFILE: Record<StylePersona, StylePersonaBgmProfile> = {
  dongbei: {
    moodHint: '市井烟火气的唠嗑叙事，轻松、有人味儿，不煽情',
    moodTags: ['市井', '轻快', '民间', '接地气'],
    bpmRange: [90, 120],
  },
  jietou: {
    moodHint: '街头吆喝式的强节奏口播，鼓点顶住每句话的卖点',
    moodTags: ['燃', '强节奏', '鼓点', '紧张'],
    bpmRange: [120, 150],
  },
  animal: {
    moodHint: '纪录片旁白的庄重与悬念，留白多、情绪克制',
    moodTags: ['纪录片', '弦乐', '庄重', '悬念'],
    bpmRange: [70, 100],
  },
};

/** 按风格包解析 BGM 情绪倾向（当前只跟人格，浓度留给后续扩展） */
export function resolveStylePackBgmProfile(pack: StylePack | null | undefined): StylePersonaBgmProfile {
  const normalized = normalizeStylePack(pack);
  return STYLE_PERSONA_BGM_PROFILE[normalized.persona];
}

/** 单个人格的完整定义 */
export interface StylePersonaProfile {
  id: StylePersona;
  /** 展示名 */
  name: string;
  /** 一句话人格说明（UI 副标题） */
  desc: string;
  /** 浓度三档的 prompt 语体指令（下标 = level） */
  directives: readonly [string, string, string];
  /** 浓度三档的开头钩子试写（仅 UI 预览，不参与生成） */
  samples: readonly [string, string, string];
  /** 人格专属禁用词 / 禁用句式（prompt 负面清单） */
  banned: readonly string[];
}

/** 三档共用红线：书面连接词、空转感叹、网络烂梗 */
export const STYLE_PACK_COMMON_BANNED = [
  '综上所述',
  '与此同时',
  '值得注意的是',
  '值得一提的是',
  '换言之',
  '众所周知',
  '令人震撼',
  '十分感人',
  '不得不说',
] as const;

/** 三个人格的定义（词库 / 钩子试写 / 禁用词） */
export const STYLE_PERSONAS: Record<StylePersona, StylePersonaProfile> = {
  dongbei: {
    id: 'dongbei',
    name: '东北大姐',
    desc: '见过世面，话糙理不糙；比喻取自生活',
    directives: [
      '东北大姐，但语体克制：像跟熟人复述一件事，句子短、口气实，先把事实与因果讲清；全篇最多保留 1~2 个东北口语词，不抖机灵、不堆段子。',
      '东北大姐唠嗑腔：像坐在炕沿上给人讲事儿，口气笃定、句子短促；每 80 字内允许 1~2 个东北口语词（整、造、咋、那可不、搁这儿、瞅着），比喻取自身边生活（酸菜缸、暖气片、菜市场）；可用一句反问收尾，但禁止复读同一句式。',
      '东北大姐、方言浓度拉满：每 50 字至少 1 个东北口语词，动作直给（造了、整明白、瞅着、搁那儿）；允许一句荒诞类比收尾（如"这哪是章鱼啊，这是蹲过点的"）；方言只加在表达层，剧情信息密度一步不许退。',
    ],
    samples: [
      '研究人员怎么也没想到，罐子是被一只章鱼拧开的。',
      '这帮研究员盯了半个月监控，最后发现小偷是个八条腿的。',
      '研究员把罐子锁上那天，章鱼就在旁边瞅着，那眼神跟看笑话似的。',
    ],
    banned: ['综上所述', '与此同时', '值得注意的是', '换言之', '绝绝子', 'yyds'],
  },
  jietou: {
    id: 'jietou',
    name: '街头大爷',
    desc: '短句、强情绪、卖点前置；适合带货与知识付费',
    directives: [
      '街头口播，但语体收敛：先把结论 / 卖点说在前面，再用两三句事实兜住；语气笃定，不喊口号、不连串感叹。',
      '街头大爷吆喝腔：开口就是强指令或提问（"你敢信吗""别眨眼"），卖点与冲突前置，短句排比推进；每 3 句至少 1 句控制在 20 字内；夸张只用于强调，不许用来编造事实。',
      '街头大爷、吆喝拉满：密集短句（每句 ≤15 字），连续指令与反问，把最反常识的点顶到第一句；允许夸张对比收尾（如"这要放出来，海鲜市场得连夜改密码"）；喊得再响，事实也必须站得住。',
    ],
    samples: [
      '你敢信吗，罐子是章鱼自己拧开的。',
      '实验室丢螃蟹了，家人们，监控一调——八条腿的。',
      '别眨眼，研究员锁罐子那天，章鱼就在旁边看着呢。',
    ],
    banned: ['综上所述', '在此背景下', '基于上述', '值得注意的是', '绝绝子'],
  },
  animal: {
    id: 'animal',
    name: '动物世界',
    desc: '正经旁白 + 动物内心 OS，两条音轨交替',
    directives: [
      '纪录片旁白：冷静、克制、书面但不堆术语，句子完整，按画面与时间顺序推进叙述。',
      '动物世界旁白 + 内心 OS 双音轨：主叙述用正经旁白腔（"它并不知道，自己正在重复一个人类做过无数次的动作"）；每 3~4 段插入 1 句以「——」引导的大白话 OS，制造语气落差；两条音轨必须指向同一件事。',
      '动物世界、落差拉满：旁白允许荒诞正经（"在它八条腕足的记忆里，这个世界第一次出现了「盖子」这个概念"），紧接着用 OS 一句话翻译（"——翻译一下：这玩意儿能拧"）；每 2 段至少 1 次落差；荒诞只加在表达上，事实一个字不许改。',
    ],
    samples: [
      '深夜的实验室里，一只章鱼靠近了那个罐子。',
      '它并不知道，自己正在重复一个人类做过无数次的动作。',
      '在它八条腕足的记忆里，这个世界第一次出现了「盖子」这个概念。',
    ],
    banned: ['老铁', '家人们', '咱们就是说', '绝绝子', 'yyds'],
  },
};

/** 人格取值校验 */
export function isStylePersona(value: unknown): value is StylePersona {
  return typeof value === 'string' && (STYLE_PERSONA_VALUES as readonly string[]).includes(value);
}

/** 浓度取值校验 */
export function isStylePackLevel(value: unknown): value is StylePackLevel {
  return value === 0 || value === 1 || value === 2;
}

/** 持久化值归一化：非法/缺失一律回退默认包（旧工程无此字段时即默认包） */
export function normalizeStylePack(raw: unknown): StylePack {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const persona = isStylePersona(record.persona) ? record.persona : DEFAULT_STYLE_PACK.persona;
  const level = isStylePackLevel(record.level) ? record.level : DEFAULT_STYLE_PACK.level;
  return { persona, level };
}

/** 是否为默认包（输入指纹兼容用：旧工程按默认包等价处理，不因新增字段集体失效） */
export function isDefaultStylePack(pack: StylePack | null | undefined): boolean {
  if (!pack) return true;
  return pack.persona === DEFAULT_STYLE_PACK.persona && pack.level === DEFAULT_STYLE_PACK.level;
}

/**
 * 组装注入 System Prompt 的人格指令块。
 * 只描述「谁在说、怎么说」，并显式声明其优先级低于剧情/角色/结构规则，避免语体覆盖内容。
 */
export function buildStylePackDirective(pack: StylePack): string {
  const normalized = normalizeStylePack(pack);
  const profile = STYLE_PERSONAS[normalized.persona];
  const levelLabel = STYLE_PACK_LEVEL_LABELS[normalized.level];
  const banned = Array.from(new Set([...profile.banned, ...STYLE_PACK_COMMON_BANNED]));
  const dualTrack = normalized.persona === 'animal'
    ? '\n- 双音轨要求：旁白与内心 OS 必须指向同一件事，OS 句一律以「——」开头，不得变成两段无关的叙述。'
    : '';
  return `## 🎭 讲述人格（风格包 · ${profile.name} · 浓度 ${levelLabel}）
${profile.directives[normalized.level]}
- 人格只决定「谁在说、怎么说」：剧情事实、角色姓名、单段字数与完结收尾规则一律优先，不得为了腔调牺牲信息或编造剧情。${dualTrack}
- 全篇禁用以下书面套话与烂梗：${banned.join('、')}。`;
}
