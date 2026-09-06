// 📁 路径：src/modules/export/backend/ExportProjectAssembler.ts
// 统一装配中心：从 DB 读取 + 镜头装配 + BGM + 字幕样式 + S8 导出范围过滤 集中在一处完成。
// 目的：真模块化落地（单一装配源），避免 ExportService 两条出口（成片/剪映）各自手搓装配。
// 设计原则：错就错、不降级、不兜底；所有失败场景 fail-fast 抛错，不静默用默认值。

import type { ExportProject, ExportShot } from '../contracts/ExportProject';
import { enrichMatchRelations } from './enrichMatchRelations';
import { AppError, ErrorCode } from '../../infra/error/AppError';

// ──────────────────────────────────────────────
// 外部依赖接口（通过参数传入，避免直接 new main 层实例）
// 运行时 ExportService 会传真实的 ProjectRepository / SettingsService 单例；
// 单元测试中传 mock 实现，避免 DB/settings 依赖。
// ──────────────────────────────────────────────

/** ProjectRepository 最小契约（仅声明装配器需要的 loadFullProjectData 方法签名） */
export interface AssemblerProjectRepo {
  loadFullProjectData(projectId: string): any;
}

/** SettingsService 最小契约（仅声明装配器需要的 getSubtitleStyle 方法签名） */
export interface AssemblerSettingsService {
  getSubtitleStyle(): any;
}

/** dehydrateMagicPath 函数签名：magic:// → 物理路径（由 main 层 pathUtils 注入） */
export type DehydrateFn = (path: string) => string;

// ──────────────────────────────────────────────
// 入参 / 出参 契约
// ──────────────────────────────────────────────

/** 装配器可选项 */
export interface AssembleExportProjectOptions {
  /** 镜头粒度的导出范围：'all'（全部，默认） | 'selected'（选中片段） */
  exportRange?: 'all' | 'selected';
  /** 当 exportRange='selected' 时的镜头 ID 白名单；空数组时抛错（不静默降级 all） */
  selectedShotIds?: string[];
  /** 未匹配段（有配音无画面切片）导出策略：
   *  - 'block'（默认，拦截式）：存在即抛错并列全量段 id，要求重跑匹配或显式改为 skip——杜绝"源视频末帧定格"（片尾出品单位字卡帧）混进成片；
   *  - 'skip'：跳过这些段（配音/字幕一并不导出），warn 计数；
   *  - 'keep'：保留旧语义（unmatched 定格导出，仅下游 exporter 单测等显式使用）。 */
  unmatchedPolicy?: 'block' | 'skip' | 'keep';
  /** 是否读取共享字幕样式（SettingsService.getSubtitleStyle()）；默认 true */
  includeSubtitleStyle?: boolean;
  /** 需要额外透传到 extras 的原始 DB 字段名（如剪映需要 scriptParagraphs 做字幕段落，成片不需要） */
  extraPayloadFields?: Array<'scriptParagraphs' | 'shots' | 'matchResults' | 'ttsResults'>;
}

/** 装配器返回值 */
export interface AssembleExportProjectResult {
  /** 统一中间数据模型（两端出口共同消费） */
  project: ExportProject;
  /** 出口专属 extras：按 extraPayloadFields 透传的原始结构化数据 */
  extras: Record<string, unknown>;
}

// ──────────────────────────────────────────────
// 默认依赖：装配器放 modules 层，不直接 new main 层对象
// 运行时 ExportService 将真实 deps 传入；单测传 mock deps。
// 这里不做任何兜底默认值，用户不传 deps 且尝试需要的功能时自然抛错。
// ──────────────────────────────────────────────

/**
 * 根据 TTS 结果构建脱水后的干净物理配音路径（无配音/失败 → undefined）。
 *
 * @param tts            TTS 结果（须含 audioUrl；_failed 表示合成失败）
 * @param dehydratePath  magic:// → 物理路径 脱水函数（可空，空则原样用 audioUrl）
 * @returns 干净物理路径；无有效配音时返回 undefined
 */
function buildAudioPath(
  tts: any,
  dehydratePath?: DehydrateFn,
): string | undefined {
  if (!tts?.audioUrl || tts._failed) return undefined;
  const dehydrated = dehydratePath ? dehydratePath(tts.audioUrl) : tts.audioUrl;
  // 去掉 file:// 前缀，保留干净物理路径；如果脱水后仍为 magic:// 前缀，按规格保留原值（由出口端 fail-fast）
  return dehydrated.replace('file://', '');
}

/**
 * 统一装配：读 DB → 镜头装配 → BGM 装配 → 字幕样式读取 → exportRange 过滤。
 * 全流程 fail-fast：DB 无项目 / 源视频缺失 / 选中片段 0 命中 / 镜头时间窗无效 均直接抛错。
 *
 * @param projectId 项目 ID
 * @param options   装配选项（范围过滤、样式读取、extras 字段等）
 * @param deps      外部依赖（DB repo、settings service、path 脱水函数）
 */
export function assembleExportProjectSync(
  projectId: string,
  options: AssembleExportProjectOptions = {},
  deps: {
    projectRepo: AssemblerProjectRepo;
    settingsService?: AssemblerSettingsService;
    dehydratePath?: DehydrateFn;
  } = {} as any,
): AssembleExportProjectResult {
  if (!projectId || typeof projectId !== 'string' || projectId.trim() === '') {
    throw new AppError(ErrorCode.SYS_INVALID_INPUT, '装配失败：缺少 projectId');
  }
  if (!deps || !deps.projectRepo || typeof deps.projectRepo.loadFullProjectData !== 'function') {
    throw new AppError(
      ErrorCode.SYS_INVALID_INPUT,
      '装配失败：缺少 projectRepo 依赖（请通过 deps.projectRepo 注入 AssemblerProjectRepo 实现）',
    );
  }

  // 1. 读 DB：项目记录不存在 → fail-fast
  const projectData: any = deps.projectRepo.loadFullProjectData(projectId);
  if (!projectData) {
    throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, `装配失败：项目数据不存在，projectId=${projectId}`);
  }

  // 2. 源视频路径（mediaItems[0].filePath）：空 → fail-fast
  const mediaItems: any[] = Array.isArray(projectData.mediaItems) ? projectData.mediaItems : [];
  // 源视频路径必须是字符串；历史脏数据若把 filePath 存成对象等非字符串，视为缺失走 fail-fast（不静默传空）
  const sourceFilePath = mediaItems[0]?.filePath;
  const rawMediaPath = typeof sourceFilePath === 'string' ? sourceFilePath : '';
  if (!rawMediaPath) {
    throw new AppError(ErrorCode.FS_FILE_NOT_FOUND, '装配失败：未找到源视频路径（mediaItems[0].filePath 为空或非字符串）');
  }
  // magic:// → 物理路径
  const mediaPath = deps.dehydratePath ? deps.dehydratePath(rawMediaPath) : rawMediaPath;

  // 3. 装配素材/配音（TTS）索引
  //   ✅ 身份键统一：产物出生处必带 id（=段落主键 seg_N），消费端一律只读 id，
  //    shotId 仅作同值兼容写入。读库路径对 legacy 缺 id 数据在此归一一次（id=id||shotId），
  //   之后索引/读取只走 id，不再做双门。
  const matchResults: any[] = (Array.isArray(projectData.matchResults) ? projectData.matchResults : [])
    .map((m: any) => (m && typeof m.id === 'string' ? m : { ...m, id: m?.shotId }));
  const ttsResults: any[] = (Array.isArray(projectData.ttsResults) ? projectData.ttsResults : [])
    .map((t: any) => (t && typeof t.id === 'string' ? t : { ...t, id: t?.shotId }));
  const ttsById = new Map<string, any>(ttsResults.map((t: any) => [t.id, t]));

  // 4. 逐镜头装配 ExportShot[]：主数据源为 matchResults（镜头匹配结果）
  //    🛡️ 2026-09-05 拦截式策略：block（默认）时收集全量未匹配段 id，装配完成后一次抛错（见第 5 步前校验），
  //    杜绝"未匹配段 → 源视频末帧定格"把片尾出品单位字卡帧混进成片（用户实测反馈）。
  const unmatchedPolicy = options.unmatchedPolicy ?? 'block';
  const unmatchedBlockIds: string[] = [];
  const shots: ExportShot[] = matchResults.flatMap((m: any) => {
    const chunk = m?.chunkData || null;
    const tts = ttsById.get(m.id);
    // 坐标系统一为【源视频坐标】（OP/ED 裁剪体系 P1-4 约定）：
    //  - videoTimelineStartMs/EndMs 是 AIService 回写换算后的源坐标真值（有裁剪时唯一正确）；
    //  - chunkData.startMs/endMs 是 body 切片内坐标（配 chunkData.filePath 切片素材才同系），
    //    无裁剪时 body==source，作为回退值等价安全。
    //  导出器对源视频 mediaPath 定位必须用源坐标；chunkData 原样保留供"素材=body 切片"消费方。
    /** 🛡️ 时间窗有效性回退：videoTimelineStart/End 来自 daemon 回写换算，历史脏数据存在
     *  "两端相等/逆序/非数字"形态（如 seg_7 startMs==endMs=32544.9），原 `??` 链只挡 nullish
     *  挡不住非空无效值，直接落到下方 start<end 校验会 fail-fast 炸整次导出。现改三级取值：
     *  timeline 有效 → 用 timeline；无效但切片窗口合法 → 回退切片窗口（救旧数据，不炸导出）；
     *  均无效 → 保持原语义（0 / 0+配音时长），交给下方 unmatched 定格兜底或 fail-fast。 */
    const rawStart = Number(m?.videoTimelineStartMs);
    const rawEnd = Number(m?.videoTimelineEndMs);
    const hasValidTimeline = Number.isFinite(rawStart) && Number.isFinite(rawEnd) && rawStart < rawEnd;
    const chunkStart = Number(chunk?.startMs);
    const chunkEnd = Number(chunk?.endMs);
    const hasValidChunkWindow = Number.isFinite(chunkStart) && Number.isFinite(chunkEnd) && chunkStart < chunkEnd;
    const startMs = hasValidTimeline ? rawStart : hasValidChunkWindow ? chunkStart : (m?.videoTimelineStartMs ?? 0);
    const endMs = hasValidTimeline ? rawEnd : hasValidChunkWindow ? chunkEnd : (m?.videoTimelineEndMs ?? startMs + (m?.audioDurationMs ?? 3000));
    // 未匹配镜头：无切片、无媒体、时间窗为 0（KM 求解未命中该段文案）。
    //   策略见 unmatchedPolicy：
    //   - block（默认）：有 TTS 配音的未匹配段全量收集到 unmatchedBlockIds → 装配后统一抛错（拦截式）；
    //   - skip：跳过该段（配音/字幕一并丢弃）并 warn；
    //   - keep：保留旧语义——导出配音+字幕，视频轨用源视频末帧定格兜底（仅显式使用，会定格片尾字卡）。
    //   无配音 → 无可导出内容，一律跳过并告警（不因单个空段中断整次导出）。
    const isUnmatched = !m?.mediaId && !chunk && startMs === 0 && endMs === 0;
    if (isUnmatched) {
      const hasTts = !!tts && !!tts.audioUrl && !tts._failed;
      const shotId = String(m?.id || m?.shotId || '?');
      if (!hasTts) {
        console.warn(`[导出装配] 跳过未匹配镜头 ${shotId}（无切片/时间窗且无配音，未参与导出）`);
        return [] as ExportShot[];
      }
      if (unmatchedPolicy === 'block') {
        unmatchedBlockIds.push(shotId);
        return [] as ExportShot[];
      }
      if (unmatchedPolicy === 'skip') {
        console.warn(`[导出装配] 跳过未匹配镜头 ${shotId}（有配音但无画面切片，已按「忽略未匹配段」不导出该段配音/字幕）`);
        return [] as ExportShot[];
      }
      // keep：未匹配段无真实源时间窗，目标时长只能取配音实际时长（错就错：缺配音时长则无法定位时间窗，fail-fast）
      const ttsDurationSec = Number(tts.duration as any);
      if (!(ttsDurationSec > 0)) {
        throw new AppError(
          ErrorCode.SYS_INVALID_INPUT,
          `装配失败：未匹配镜头 ${shotId} 有配音但缺时长（tts.duration 无效），无法定位时间窗`,
        );
      }
      return [{
        id: m.id,
        mediaId: '',
        text: m?.text,
        aiText: m?.aiText,
        start: 0,
        end: ttsDurationSec,
        duration: ttsDurationSec,
        audioPath: buildAudioPath(tts, deps.dehydratePath),
        unmatched: true,
      }];
    }
    // 不变式：start < end，否则时间窗非法（对真实数据仍 fail-fast，不静默兜底）
    if (!(startMs < endMs)) {
      throw new AppError(
        ErrorCode.SYS_INVALID_INPUT,
        `装配失败：镜头 ${m?.shotId ?? '?'} 时间窗无效（startMs=${startMs}, endMs=${endMs}）`,
      );
    }
    const audioPath = buildAudioPath(tts, deps.dehydratePath);
    return {
      id: m.id,
      mediaId: m?.mediaId || '',
      text: m?.text,
      aiText: m?.aiText,
      start: startMs / 1000,
      end: endMs / 1000,
      duration: (endMs - startMs) / 1000,
      audioPath,
      chunkData: chunk,
      videoTimelineStartMs: startMs,
      videoTimelineEndMs: endMs,
      appliedSpeedFactor: m?.appliedSpeedFactor,
      keepOriginalAudio: m?.keepOriginalAudio === true,
    };
  });

  // 4.5 🛡️ 未匹配段拦截（block 默认策略）：存在即抛错并列全量段 id——
  //     画面缺失必须暴露给用户处理（重跑匹配 或 显式选择跳过），杜绝静默"末帧定格"把片尾字卡帧导进成片。
  if (unmatchedPolicy === 'block' && unmatchedBlockIds.length > 0) {
    throw new AppError(
      ErrorCode.SYS_INVALID_INPUT,
      `导出失败：${unmatchedBlockIds.length} 段文案未匹配到画面切片（${unmatchedBlockIds.join('、')}），` +
      `无法为这些段落提供有效画面。请在步骤5 对未匹配段落重跑匹配；若确认忽略这些段落（不导出其配音/字幕），` +
      `请在导出时选择「忽略未匹配段」后再试。`,
    );
  }

  // 5. 阶段 A 相邻镜头关系增强：识别同物理镜头连续子段（假转场），写入 parentChunkId/prevRelation/sceneGroupId
  //    在 S8 过滤之前执行——基于完整时间线计算组归属，过滤只做子集投影不破坏组内关系。
  const enrichedShots = enrichMatchRelations(shots);
  // 6. S8 导出范围过滤：集中执行，无命中 fail-fast（不静默降级为全部）
  const exportRange = options.exportRange ?? 'all';
  const scopedShots = applyExportRange(enrichedShots, exportRange, options.selectedShotIds);

  // 6. BGM 装配：优先 extractedBgm（mediaItems type=audio 且 extractedBgm）→ 其次 activeBgm → 都无则 undefined
  //    ⚠️ activeBgm 持久化为对象 { id, filePath, name, bpm }（ProjectRepository 持久化约定，
  //    曲库点选的 BGM 走此形态）；此处必须取 .filePath——若把对象直接当路径传给
  //    dehydrateMagicPath，会被其类型守卫归一为空串，下游 if(bgmPath) 判空导致
  //    剪映草稿 BGM 轨道静默丢失。字符串形态（历史数据/分离伴奏直接存路径）保持兼容。
  const bgmItem = mediaItems.find((mi: any) => mi && mi.type === 'audio' && mi.extractedBgm);
  const rawActiveBgm = projectData.activeBgm as string | { filePath?: string } | null | undefined;
  const activeBgmPath = typeof rawActiveBgm === 'string' ? rawActiveBgm : rawActiveBgm?.filePath;
  let bgmPath: string | undefined = bgmItem?.extractedBgm || activeBgmPath || undefined;
  if (bgmPath && deps.dehydratePath) {
    bgmPath = deps.dehydratePath(bgmPath).replace('file://', '');
  }

  // 8. 字幕样式（按需读取）
  let subtitleStyle: Record<string, unknown> | undefined;
  if (options.includeSubtitleStyle !== false) {
    if (!deps.settingsService || typeof deps.settingsService.getSubtitleStyle !== 'function') {
      throw new AppError(
        ErrorCode.SYS_INVALID_INPUT,
        '装配失败：includeSubtitleStyle=true 时必须注入 deps.settingsService（实现 getSubtitleStyle）',
      );
    }
    subtitleStyle = deps.settingsService.getSubtitleStyle() as Record<string, unknown>;
  }

  // 8. 组装统一中间模型
  const project: ExportProject = {
    projectId,
    projectName: projectData.projectName || projectData.name || '',
    mediaPath,
    bgmPath,
    shots: scopedShots,
    subtitleStyle,
    // ratio / resolution / fps / preview 属出口专属参数，由各出口自行写入 job.payload，不在此处装配
  };

  // 10. extras：按 extraPayloadFields 透传原始 DB 结构化字段（剪映端需要 scriptParagraphs 做字幕段落）
  const extras: Record<string, unknown> = {};
  const extraFields = options.extraPayloadFields || [];
  for (const f of extraFields) {
    if (f === 'scriptParagraphs') extras.scriptParagraphs = projectData.scriptParagraphs || [];
    else if (f === 'shots') extras.shots = projectData.shots || [];
    else if (f === 'matchResults') extras.matchResults = projectData.matchResults || [];
    else if (f === 'ttsResults') extras.ttsResults = projectData.ttsResults || [];
  }

  return { project, extras };
}

// ──────────────────────────────────────────────
// 内部工具：S8 范围过滤
// 与 ExportService.applyExportRange 语义一致（集中实现，不必跨层引用）
// ──────────────────────────────────────────────

/**
 * 按导出范围过滤镜头数组。
 * - exportRange !== 'selected' 时原样返回
 * - 'selected' 时仅保留 ids 命中的镜头；0 命中抛错（避免静默降级为全部）
 */
function applyExportRange<T extends { id: string }>(
  shots: T[],
  exportRange: string,
  selectedShotIds?: string[],
): T[] {
  if (exportRange !== 'selected') return shots;
  const selected = new Set(selectedShotIds || []);
  // S8 fail-fast：空数组 / undefined → 显式抛错，不静默 all
  if (selected.size === 0) {
    throw new AppError(
      ErrorCode.SYS_INVALID_INPUT,
      '装配失败：exportRange=selected 但未提供任何选中片段的 shotId（selectedShotIds 为空）',
    );
  }
  const filtered = shots.filter((s) => selected.has(s.id));
  if (filtered.length === 0) {
    throw new AppError(
      ErrorCode.SYS_INVALID_INPUT,
      `选中的片段未匹配到可导出的镜头（共 ${shots.length} 段，选中 ${selected.size} 个 id，0 命中），请重新选中`,
    );
  }
  return filtered;
}
