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
import { resolveForMedia, applyToChunks, type ResolvedTrim } from '../utils/MediaTrimPolicy';
import { TrimmedSourceResolver } from '../utils/TrimmedSourceResolver';
import { PathManager } from '../../utils/pathManager';
import { JobScheduler } from '../../core/JobScheduler'; // 🔧 R12（PR-3）：任务准入合并 —— 检测步骤1 是否在跑
import { ComputeResourceManager } from '../../core/ComputeResourceManager'; // 🔧 R12（PR-3）：激活 canStartNewTask 全局资源准入信号

/**
 * 镜头匹配策略：三维一体弹性时间轴对齐
 * 维度一：解说词与视频片段的 CLIP 语义相似度
 * 维度二：刚性音频时长与视频片段原长的时差惩罚
 * 维度三：BGM 鼓点磁吸吸附权重
 * 使用匈牙利算法求解全局最优排他性匹配
 */
export class SemanticAnalyzeStrategy extends BaseNodeStrategy {
  readonly nodeType = 'semantic-analyze';

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
    onProgress: (p: number, s: string) => void
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
      return { matches: [], segments: [] };
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
    const projectId: string = (task as any).projectId ?? String((task as any).project ?? '');
    const mediaAssetId: string = (task as any).mediaId || (task as any).assetId || '';
    const trim: ResolvedTrim = resolveForMedia(projectId, mediaAssetId);
    const needTrim = trim.trimStartMs > 0 || trim.trimEndMs > 0;
    const { chunks: _probeForFingerprint, trimFingerprint } = applyToChunks([], trim);
    void _probeForFingerprint;
    // 2.2 视频切片缓存 key：原始 key 与「带 trim 隔离 key」双版本，避免缓存错配
    const videoRepo = new VideoChunkRepository();
    const rawCacheKey = projectId ? `${projectId}:${mediaPath}` : mediaPath;
    const trimAwareCacheKey = needTrim ? `${rawCacheKey}#${trimFingerprint}` : rawCacheKey;
    let chunks: any[] = [];
    let matchSegments: any[] = [];
    try {
      /** 🎬 方向3（跨项目切片污染纵深防御）：优先复用前端注入的本项目已保存切片池
       *  （task.videoChunks ← step5State.videoChunks ← metadata.videoChunks ← 本项目上一次步骤5 结果回传）。
       *  仅无 OP/ED 裁剪时启用（源坐标=body 坐标，复用零坐标风险）；needTrim 时 metadata 切片
       *  坐标契约不透明（可能 body 也可能源坐标），仍走下方 trimAware 缓存链路，避免坐标二次平移错配。
       *  契约校验与 P1 一致：非空且含 colorHistogram，不满足按"错就错"原则降级。 */
      const ownPool: any[] = Array.isArray(task.videoChunks) ? task.videoChunks : [];
      const ownPoolUsable = !needTrim && ownPool.length > 0
        && ownPool.some((c: any) => Array.isArray(c.colorHistogram) && c.colorHistogram.length > 0);
      if (ownPoolUsable) {
        chunks = ownPool;
        matchSegments = SemanticAnalyzeStrategy.buildMatchSegmentsFromChunks(chunks);
        AppLogger.info(LOG_TAGS.AI_AGENT,
          `[镜头匹配] 方向3: 优先复用本项目已保存切片池 ${chunks.length} 个镜头，候选段 ${matchSegments.length} 个（跳过 daemon 跨项目缓存）`);
      } else {
      /** 🔧 先查 SQLite 切片缓存：先命中「trimAware key」（精确值），再回落到 raw key 做 Node 侧平移裁剪 */
      let cached = videoRepo.getByMediaId(trimAwareCacheKey) || (needTrim ? videoRepo.getByMediaId(rawCacheKey) : null);
      /** 🎨 P1 缓存契约校验：切片须含 colorHistogram（相邻切片色调连续性特征，P1 新增）。
       *  旧版缓存缺该字段，按"错就错"原则视为数据契约不满足，失效重切（不能静默跳过色调维度）。 */
      const cacheUsable = cached && cached.chunks.length > 0
        && cached.chunks.some((c: any) => Array.isArray(c.colorHistogram) && c.colorHistogram.length > 0);
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
          if (workingChunks.length > 0) videoRepo.save(trimAwareCacheKey, workingChunks, workingSegs);
        } else {
          AppLogger.info(LOG_TAGS.AI_AGENT, `[镜头匹配] OP/ED: 命中缓存 key=${trimAwareCacheKey.slice(-22)} chunks=${workingChunks.length} segs=${workingSegs.length}`);
        }
        chunks = workingChunks;
        matchSegments = workingSegs;
        /** 阶段 B 兼容：v1 老缓存只有 chunks 数组（无 matchSegments）→ 用 Node 侧兜底生成候选段，
         *  避免老缓存全部失效强制重切片（ADR B-3 要求的降级分支）。 */
        if (matchSegments.length === 0) {
          matchSegments = SemanticAnalyzeStrategy.buildMatchSegmentsFromChunks(chunks);
        }
        AppLogger.info(LOG_TAGS.AI_AGENT, `[镜头匹配] 命中视频切片 DB 缓存，镜头 ${chunks.length} 个，匹配候选段 ${matchSegments.length} 个`);
      } else {
        if (cached && cached.chunks.length > 0) {
          AppLogger.info(LOG_TAGS.AI_AGENT, `[镜头匹配] 旧版切片缓存缺色调特征（colorHistogram），按契约校验失效，重新切片以启用衔接优化`);
        }
        const chunksDir = path.join(cacheDir, 'video_chunks');
        /** 🎬 P1-4 OP/ED 源头裁剪：needTrim 时先按 body 窗口切视频（TrimmedSourceResolver），
         *  只切片正剧段，chunks/segments 天然 body 坐标（省 OP/ED 算力 + 免除 Node 侧平移）。
         *  mediaId 用切片路径做缓存隔离，避免不同 trim 值/整段缓存错配；resolve 失败回退整段。 */
        let sceneSource = mediaPath;
        let sceneMediaId = mediaPath;
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
            }
          } catch (e: any) {
            AppLogger.warn(LOG_TAGS.AI_AGENT, `[镜头匹配] OP/ED 场景切片源裁剪失败，回退整段: ${e.message}`);
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
        }, { timeout: 300000 });
        const chunkData = chunkResult?.data || chunkResult;
        chunks = Array.isArray(chunkData)
          ? chunkData
          : (Array.isArray((chunkData as any)?.chunks) ? (chunkData as any).chunks : []);
        const segs = Array.isArray((chunkData as any)?.matchSegments) ? (chunkData as any).matchSegments : [];
        /** 阶段 B 兜底：daemon 为旧版本（仅返回数组、无 matchSegments）时原地生成候选段，避免候选池契约缺项 */
        matchSegments = segs.length > 0 ? segs : SemanticAnalyzeStrategy.buildMatchSegmentsFromChunks(chunks);
        /** 🎬 P0/P1-4 OP/ED：body 窗口切片产物已是 body 坐标，无需再平移（raw key 回落整段缓存的平移已在上方缓存分支处理） */
        if (needTrim && chunks.length > 0) {
          AppLogger.info(LOG_TAGS.AI_AGENT,
            `[镜头匹配] OP/ED: 场景切片按 body 窗口切片完成 chunks=${chunks.length} segs=${matchSegments.length}（天然 body 坐标，无 Node 平移）`);
        }
        /** 切片成功后持久化到 SQLite：
         *   - 无 trim 时写原始 key（供后续无 trim/任意 trim 回落使用）
         *   - 有 trim 时额外写 trimAware key，下次命中秒级跳过平移 */
        if (chunks.length > 0) {
          try {
            // 无 trim（整段源坐标切片）永远先写 raw key，让后续不同 trim 值都能回落 Node 平移
            if (!needTrim) { videoRepo.save(rawCacheKey, chunks, matchSegments); }
            // 🎬 P1-4：needTrim 时切片源已是 body 窗口，产物为 body 坐标 → 只写 trimAware key；
            //  不再写 raw key（raw key 语义=整段源坐标，body 坐标数据写入会导致无 trim/其他 trim 回落时坐标错配）
            if (needTrim) { videoRepo.save(trimAwareCacheKey, chunks, matchSegments); }
          } catch (e: any) {
            AppLogger.warn(LOG_TAGS.AI_AGENT, `[镜头匹配] 写切片缓存失败: ${e.message}`);
          }
        }
        AppLogger.info(LOG_TAGS.AI_AGENT, `[镜头匹配] 场景切片检测完成，镜头 ${chunks.length} 个，匹配候选段 ${matchSegments.length} 个`);
      }
      }
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[镜头匹配] 场景切片检测失败: ${e.message}，回退到帧匹配模式`);
    }

    /** 步骤2 逐帧 VLM 描述聚合：按时间轴把帧描述归入切片（chunk.description），
     *  供 daemon 做"文案↔切片描述"文本语义匹配——复用步骤2 已花成本的画面理解，零额外 VLM 调用；
     *  无描述切片退化为纯图像语义。
     *  🎭 P0 意境维度：同步聚合帧情绪/景别为切片情绪标签（chunk.emotion/shotType），
     *  供 daemon 做"文案情绪↔画面情绪"匹配（文案段落 emotion 来自步骤3 LLM 生成，帧 emotion 来自步骤2 VLM 结构化输出）。
     *  🎬 P0 OP/ED：先平移 frameDescs.timeMs -= trimStartMs，再删除 OP/ED 区间外的帧描述，
     *     保证帧时间轴与 chunks（已平移）完全对齐，避免双指针聚合空归。 */
    const frameDescsRaw: { timeMs: number; description: string; emotion?: string; shotType?: string; characters?: string[] }[] = (task.frameDescriptions || []).map((f: any) => {
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
        characters: mergedRoles.size > 0 ? Array.from(mergedRoles) : undefined,
      };
    });
    /** 🎬 帧时间坐标自适应转换（P1-5 修正）：源坐标帧时间戳 → body（-trimStartMs），
     *  估算/body 坐标帧时间戳保持原样。判据：首帧时间 ≥ OP 结束点（trimStartMs）即视为源坐标。
     *  无裁剪时源=body（偏移 0），转换恒等、无副作用。 */
    const frameDescs = (needTrim && frameDescsRaw.length > 0 && frameDescsRaw[0].timeMs >= trim.trimStartMs)
      ? frameDescsRaw.map((f) => ({ ...f, timeMs: Math.max(0, f.timeMs - trim.trimStartMs) }))
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
      const roleCounts = new Map<string, number>();

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
        for (const r of (f.characters || [])) {
          if (typeof r === 'string' && r.trim()) {
            const key = r.trim();
            roleCounts.set(key, (roleCounts.get(key) || 0) + 1);
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
        for (const r of (f.characters || [])) {
          if (typeof r === 'string' && r.trim()) {
            const key = r.trim();
            const c = (roleCounts.get(key) || 0) - 1;
            if (c <= 0) roleCounts.delete(key); else roleCounts.set(key, c);
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

        if (descOrder.length > 0) chunk.description = descOrder.join('；');
        if (emotionCounts.size > 0) {
          chunk.emotion = [...emotionCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        }
        if (shotTypeCounts.size > 0) {
          chunk.shotType = [...shotTypeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        }
        if (roleCounts.size > 0) chunk.characters = [...roleCounts.keys()];
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
      const withCharacters = chunks.filter((c) => Array.isArray(c.characters) && c.characters.length > 0).length;
      const withKeywords = chunks.filter((c) => Array.isArray(c.keywords) && c.keywords.length > 0).length;
      AppLogger.info(LOG_TAGS.AI_AGENT,
        `[镜头匹配] 帧描述聚合完成（含 Phase 0 结构化回捞）：` +
        `${withDesc}/${chunks.length} 带画面描述，` +
        `${withEmotion}/${chunks.length} 带情绪，` +
        `${withShotType}/${chunks.length} 带景别shotType，` +
        `${withCharacters}/${chunks.length} 带角色characters，` +
        `${withKeywords}/${chunks.length} 带关键词keywords`);
      /** 🎬 阶段 B：把镜头级语义字段 inherit 到匹配候选级 matchSegments。
       *  matchSegments 是 Python 侧按 3s 拆出的候选段（无独立 VLM 帧聚合），
       *  它们的 description/emotion/shotType/characters 全部继承自所属物理镜头的聚合结果，
       *  保证 KM 的"文案↔候选段"匹配与"文案↔镜头"匹配共享同一套语义口径。 */
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
          if (Array.isArray(parent.characters) && parent.characters.length > 0) seg.characters = parent.characters;
          if (Array.isArray(parent.keywords) && parent.keywords.length > 0) seg.keywords = parent.keywords;
        }
      }
    }

    /** 步骤3：构建 KM 匹配请求 */
    onProgress(40, `正在匹配 ${scriptShots.length} 段文案与画面...`);
    /**
     * 构造带音频时长 + 多维字段（情绪/角色/画面意图/时间锚/原声标记）的 query 列表，
     * 复用共享纯函数 buildMatchQueries（避免 AIService 与本策略的 query 构造漂移）。
     */
    const allQueries = SemanticAnalyzeStrategy.buildMatchQueries(scriptShots, ttsDurations, needTrim ? trim.trimStartMs : 0);

    /** 🔧 P2.0 碎片 seg 前置清洗（KM 与原声定位共用同一清洗后池）：合并 <500ms 碎片到相邻 seg，
     *  从源头降低变速超限触发概率（碎片单段天然时长不足，是重选常客）。运行时清洗，不落库。 */
    SemanticAnalyzeStrategy.mergeFragmentSegments(matchSegments);

    /** 🎙️ 原声段落预匹配：文本 ↔ ASR 时间轴 → 锁定原片切片（命中的段落不送 KM，未命中回退语义匹配）
     *  🔧 P1 #7：用 promisePool（并发 8）并行化原声定位。
     *  locateOriginalClip 内部是纯 JS（文本规范化 + ASR 线性扫描 + 切片二分定位），对 CPU 很友好，
     *  并发能把大段 ASR（>200 行 + >50 原声段落）的定位时间缩短 ~60%。
     *  🎬 坐标系契约（P1-5 修正）：ASR 时间轴为【源坐标】（步骤1 全链路源坐标），而 matchSegments
     *  在 OP/ED 裁剪下为【body 坐标】。定位前把 ASR 时间统一转 body，否则 trimStartMs>0 时
     *  二分覆盖查找（findCoveringChunk 按 chunk.startMs）永远定位不到切片。 */
    const asrLinesBody = needTrim
      ? asrLines.map((l: any) => {
          const s = l?.startMs;
          const e = l?.endMs;
          return {
            ...l,
            startMs: typeof s === 'number' ? Math.max(0, s - trim.trimStartMs) : s,
            endMs: typeof e === 'number' ? Math.max(0, e - trim.trimStartMs) : e,
          };
        })
      : asrLines;
    const originalMatches = new Map<string, any>();
    const originalQueries = allQueries.filter((q) => q.keepOriginalAudio);
    if (originalQueries.length > 0) {
      const locResults = await promisePool(
        originalQueries.map((q) => () => Promise.resolve().then(() => ({
          shotId: q.shotId,
          query: q,
          loc: SemanticAnalyzeStrategy.locateOriginalClip(q.text, asrLinesBody, matchSegments),
        }))),
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
          AppLogger.warn(LOG_TAGS.AI_AGENT, `[镜头匹配] 原声段落 ${r.shotId} 未在 ASR 时间轴命中，回退语义匹配`);
        }
      }
    }
    /** 送 KM 的查询：排除已命中原声段落，避免其干扰全局求解 */
    const kmQueries = allQueries.filter((q) => !(q.keepOriginalAudio && originalMatches.has(q.shotId)));
    /** 进度细分（L1 权重段）：原声定位完成，进入候选筛选与 KM 求解前的中间锚点 */
    onProgress(50, '原声段落定位完成，正在筛选语义匹配候选...');

    if (kmQueries.length === 0) {
      /** 全部段落都是已命中的原声段落：直接组装结果，无需 KM */
      onProgress(100, '原声段落定位完成（无语义匹配段落）');
      const matches = allQueries.map((q) => SemanticAnalyzeStrategy.buildMatchResult(q, originalMatches.get(q.shotId), true));
      return { matches, segments: [], videoChunks: chunks, matchSegments, bgmBeats, originalMatchedCount: originalMatches.size };
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
    /** 进度细分（L1 权重段）：KM 为原子长耗时调用（长视频可能数分钟），进入前锚定进度避免 40 直跳 80 */
    onProgress(60, '正在调用匹配算法求解全局最优组合（长视频可能需要数分钟）...');
    try {
      const kmResult = await AIDaemon.getInstance().post('/api/solver/kuhn_munkres_match', {
        queries: kmQueries,
        videoChunks: kmVideoChunks,
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
            new VideoChunkRepository().save(rawCacheKey, chunks, matchSegments);
            AppLogger.info(LOG_TAGS.AI_AGENT, `[镜头匹配] clipZhEmbedding 缓存落库：${merged}/${matchSegments.length} 切片已回写 DB`);
          } catch (e: any) {
            AppLogger.warn(LOG_TAGS.AI_AGENT, `[镜头匹配] clipZhEmbedding 缓存落库失败: ${e.message}`);
          }
        }
      }

      /**
       * 将匹配结果转换为前端需要的格式（保持 allQueries 原始顺序；原声命中段优先取定位结果）。
       * 先把 matchData 转成 shotId→item 索引，回填 O(1)；旧实现 allQueries.map × matchData.find 的 O(N·M) 替代。
       */
      const matchData: any[] = kmResult?.results || kmResult?.data || [];
      const matchById = new Map<string, any>();
      for (const m of matchData) {
        const sid = (m as any)?.shotId;
        if (sid) matchById.set(String(sid), m);
      }
      const matches = allQueries.map((q) => {
        /** 原声段落：命中定位则直接用定位结果 */
        const original = originalMatches.get(q.shotId);
        if (original) {
          return SemanticAnalyzeStrategy.buildMatchResult(q, original, true);
        }
        const matched = matchById.get(q.shotId);
        if (matched) {
          /** 🔧 P2 #11：方案 A 中 daemon 拿到的是过滤后的 kmVideoChunks，chunkData 可能被裁剪；
           *   这里若 chunkData 缺失则补回 originalChunksById 的完整副本（保证下游 JianYing/Prima 导出不丢列）。 */
          const withFullChunk = matched.chunkData
            ? matched
            : { ...matched, chunkData: originalChunksById.get(String(matched.chunkId || matched.mediaId || '')) || null };
          return SemanticAnalyzeStrategy.buildMatchResult(q, withFullChunk, false);
        }
        /** 未匹配到的段落 */
        return SemanticAnalyzeStrategy.buildMatchResult(q, null, false);
      });

      /** 📊 审计：KM 最终匹配 vs Top-K 预选集合。命中率 <0.95 打 warn，方便后续调 K。 */
      SemanticAnalyzeStrategy.auditPreselectTopK(perQueryTopKForAudit, matches, _context.projectId);

      onProgress(100, '镜头匹配完成');
      return { matches, segments: matchData, videoChunks: chunks, matchSegments, bgmBeats, originalMatchedCount: originalMatches.size };
    } catch (e: any) {
      AppLogger.error(LOG_TAGS.AI_AGENT, 'KM 匹配算法失败，回退到 CLIP 帧匹配', e);

      /** 回退：使用原有的 CLIP 帧匹配（原声段落仍保留定位结果）。
       *  🔧 P2 #11：KM 失败回退时不使用预选过滤，直接用原始 chunks 全集跑 CLIP fallback，避免"预选导致池子太小"的假回退。 */
      const fallbackQueries = kmQueries;
      const fallback = await this.fallbackFrameMatch(fallbackQueries, cacheDir, onProgress);
      /** 同样预建 shotId→fallbackMatch 索引，避免 allQueries.map + .find 的 O(N·M) */
      const fallbackById = new Map<string, any>();
      for (const m of (fallback.matches || [])) {
        const sid = (m as any)?.shotId;
        if (sid) fallbackById.set(String(sid), m);
      }
      const matches = allQueries.map((q) => {
        const original = originalMatches.get(q.shotId);
        if (original) {
          return SemanticAnalyzeStrategy.buildMatchResult(q, original, true);
        }
        return fallbackById.get(q.shotId) || SemanticAnalyzeStrategy.buildMatchResult(q, null, false);
      });
      return { matches, segments: fallback.segments, videoChunks: chunks, matchSegments, bgmBeats, originalMatchedCount: originalMatches.size };
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
    if (!win) return null;
    const startMs = win.sourceStartMs;
    const endMs = win.sourceEndMs;

    /** 2. 找覆盖 [startMs, endMs] 时间窗的切片（优先完整覆盖，其次 ±500ms 容差）。
     *    切片天然按 startMs 升序，用二分 O(log C) 定位到 startMs 附近，再在相邻 2-3 个切片内判定覆盖。 */
    const chunk = SemanticAnalyzeStrategy.findCoveringChunk(videoChunks, startMs, endMs, 0)
      || SemanticAnalyzeStrategy.findCoveringChunk(videoChunks, startMs + 500, endMs - 500, 0);
    if (!chunk) return null;

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
    //   判断标准：去掉 emoji/标点/数字后，中文汉字少于 2 个且整句长度 <8 字 → 视为"短语气词"，统一走 NARRATIVE_HOLD 模板，不做关键词抽取。
    const textRaw = String(shot.text || '').replace(/\r?\n/g, ' ').trim();
    const chineseChars = textRaw.match(/[\u4e00-\u9fa5]/g) || [];
    const hasMeaningfulText = (textRaw.length >= 8 || chineseChars.length >= 2);
    const text = hasMeaningfulText ? textRaw : ''; // 文本过短 → 当空 text 处理（不用于"解说词：xxx"模板）
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
    // 💥 极端兜底：即使所有模板都没产出（理论不会），也要给出一个 >=8 字的合法 visualIntent
    if (!result || result.length < 8) {
      const backupArr = ['【中景】过渡叙事镜头，承接上下文', '【全景】过场画面，保持叙事连贯', '【近景】停顿镜头，强调情绪承接'];
      result = backupArr[(index | 0) % backupArr.length];
    }
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
   * @param scriptShots 步骤3 产出的解说文案段落数组（含 text/emotion/visualIntent...）
   * @param ttsDurations 步骤4 产出的配音结果数组（含 shotId/duration）
   */
  static buildMatchQueries(
    scriptShots: any[],
    ttsDurations: any[],
    /** 🎬 坐标系契约（P1-5 修正）：query.startMs 供 KM 锚定加成 / preselectTopK 时间锚分，
     *  与 body 坐标切片比较前必须减 trimStartMs 转 body（步骤3 写入的 startMs 为源坐标）。
     *  默认 0 = 不转换（无 OP/ED 或调用方自行处理）。 */
    trimStartMs: number = 0,
  ): Array<{
    shotId: string;
    text: string;
    audioDurationMs: number;
    emotion: string;
    characters: string[];
    visualIntent: string;
    startMs: number;
    durationMs: number;
    keepOriginalAudio: boolean;
  }> {
    // 🎯 Phase 2：Step5 二次兜底 — 保证所有 query 的 visualIntent 100% 非空（老项目 canvas_data 里的 shots 也能覆盖）
    const filledShots = SemanticAnalyzeStrategy.ensureAllVisualIntentFilled(scriptShots || []);
    /** TTS 索引：按 id 一次 O(N) 建，单次查询 O(1)，避免 N×M .find 热点；
     *  ✅ 身份键统一：TTS 产物 id/shiedId 同源即段落主键，一律按 id 关联 */
    const ttsById = new Map<string, any>();
    for (const t of ttsDurations || []) {
      const id = (t as any)?.id || (t as any)?.shotId;
      if (id) ttsById.set(String(id), t);
    }
    return filledShots.map((s: any) => {
      // ✅ 身份键统一：段落主键 id（出生处 seg_{idx} 全局唯一）为唯一身份键，
      //   shotId 与其同源；此 id 一路透传为 MatchResult.id，即前端 React key，必须等于主键。
      const shotId = s.id;
      const ttsResult = ttsById.get(String(s.id));
      const audioDurationMs = ttsResult?.duration ? Math.round(ttsResult.duration * 1000) : 0;
      const visualIntent = String(s.visualIntent || '').trim();
      // 🎯 Phase 2：把 visualIntent 拼接到 text 末尾（独立段落符号 | 分隔），
      //   让纯文本相似度打分（preselectTopK / KM / VLM 文本匹配）零改动就能吃 visualIntent 信号。
      //   比例控制：text 仍占主要权重（不重复、不重写），visualIntent 作为补充 tag 追加。
      const textRaw = s.text || s.content || s.narration || '';
      const text = visualIntent.length > 0 ? `${textRaw} | ${visualIntent}` : textRaw;
      // 🔧 修复 Bug B：之前只认 s.startMs / s.durationMs，老项目 / 只跑了 Step1 的项目只提供 start/end（秒），
      //   导致 startMs 全部变 0，Step5 overlap 推算永远打在 0ms，匹配结果一句也对不上
      const timing = SemanticAnalyzeStrategy._resolveScriptShotTiming(s);
      return {
        shotId,
        text,
        audioDurationMs,
        emotion: s.emotion || '',
        characters: Array.isArray(s.characters) ? s.characters : [],
        visualIntent,
        startMs: trimStartMs > 0 ? Math.max(0, timing.startMs - trimStartMs) : timing.startMs,
        durationMs: timing.durationMs,
        /** 原声判定双口径：上游段落经 Normalizer 净化后只有 type 判别标记，老项目段落仍是 legacy keepOriginalAudio 布尔 */
        keepOriginalAudio: s.type === 'original_audio' || s.keepOriginalAudio === true,
      };
    }).filter(q => (q.text.split('|')[0] || '').trim().length > 0);
  }

  /**
   * P2 #11：KM Top-K 预选（方案 A：Node 侧整体收窄 videoChunks，不改 daemon 契约）。
   *
   * 设计要点：
   *   - 双通道打分融合：α·TF-IDF 文本相似度 + β·时间锚近邻分，不用 embedding，零额外 RPC
   *   - 动态 K：K = max(15, ceil(N·1.8), ceil(M·6%))，夹到 [15, M]，小项目自动回全量不失真
   *   - 质量保护：① 描述覆盖率 <30% 直接跳预选 ② 单 query 的 topK 时间跨度不足 3·audioDuration 就扩张
   *     ③ 候选并集 ≥ 2N（KM 排他性分配需要足够"预算池"）
   *   - 审计用 perQueryTopK：记录每个 query 的候选 chunkId 集合，KM 返回后用于计算"命中占比"
   *     （真实匹配 chunk 是否在预选集合里），低于 0.95 打 warn，方便后续调参。
   */
  static preselectTopK(
    queries: Array<{
      shotId: string; text: string; audioDurationMs: number;
      emotion?: string; visualIntent?: string; startMs: number; durationMs: number;
    }>,
    videoChunks: Array<{
      id: string; startMs: number; endMs: number; description?: string;
      emotion?: string; shotType?: string; characters?: string[];
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
    const alpha = opts?.alpha ?? 0.55;
    const beta = opts?.beta ?? 0.45;
    const minDescCoverage = opts?.minDescCoverage ?? 0.3;

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

    /** 保护规则①：description 覆盖率 <30%，纯时间锚信号太弱，直接跳预选（注意这里用补完后的 workingChunks） */
    const withDesc = workingChunks.filter((c) => (c.description || '').trim().length > 0).length;
    if (withDesc / Math.max(1, M) < minDescCoverage) {
      AppLogger.info(LOG_TAGS.AI_AGENT,
        `[preselectTopK] ${opts?.logProjectId || ''} 切片描述覆盖率=${(withDesc / M * 100).toFixed(1)}% < ${minDescCoverage * 100}%，跳过预选（保留全集 M=${M}）`);
      // 跳过预选也返回原 videoChunks（不返回 workingChunks，避免下游感知"继承标记"）
      return fallback;
    }

    /** 动态 K：≥15 / ≥1.8N（KM 池子足够）/ ≥6%M，三者取最大后夹到 [15, M] */
    let K = Math.max(15, Math.ceil(N * 1.8), Math.ceil(M * 0.06));
    K = Math.min(K, M);
    /** 小项目自动跳预选（放松阈值 + 绝对保护）：
     *  - K*1.2 ≥ M：比例上接近全集，剪了反而引入噪声（从1.5降到1.2，让更多中小项目跳预选）
     *  - M ≤ 30：绝对小池，KM 算法 N³/M² 复杂度已很低，直接保留全集（防裁剪后只剩 24 个 seg 时硬被预选再砍）
     *  两条任一触发 → 跳预选 */
    if (K * 1.2 >= M || M <= 30) {
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
    const perQueryScored: Array<Array<{ cid: string; score: number; midMs: number }>> = [];

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

      const scored: Array<{ cid: string; score: number; midMs: number }> = [];
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

        /** (B) 时间锚分：重叠越大 / 外扩 gap 越小，分数越高 */
        const overlap = Math.max(0, Math.min(qEnd, cEnd) - Math.max(qSt, cSt));
        const gap = Math.max(0, cSt - qEnd, qSt - cEnd);
        /** 0.002 = 500ms 重叠 bonus 到 0.73 sigmoid 平台，1s gap 回到 ~0.12，足够拉开分布 */
        const sTime = sigmoid(0.002 * (overlap - gap));

        const score = alpha * sText + beta * sTime;
        scored.push({ cid: chunk.id, score, midMs: cMid });
      }
      scored.sort((a, b) => b.score - a.score);
      perQueryScored.push(scored);

      /** 先选出 K 个，然后执行"质量保护② 多样性扩张"：
       *  如果 topK 的 min/max midMs 跨度 < 3·qDur，说明候选挤在同一小区间里（极可能是文本语义偶然高分），
       *  往 K+1 一直补，直到跨度达标或补到 2K（最多翻一倍，防止过扩张）。 */
      let kk = K;
      if (scored.length > K) {
        const minSpanMs = 3 * qDur;
        let lo = scored[0].midMs, hi = scored[0].midMs;
        for (let i = 0; i < K; i++) { lo = Math.min(lo, scored[i].midMs); hi = Math.max(hi, scored[i].midMs); }
        let i = K;
        while (i < scored.length && i < 2 * K && (hi - lo) < minSpanMs) {
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
   * 审计工具：对比"KM 最终匹配结果"与"预选 top-K 集合"，输出真实覆盖率。
   *  单项目命中率 < 0.95 打 warn，提示需要调 K 或分数融合参数。
   * @param perQueryTopK preselectTopK 返回的 perQueryTopK
   * @param matches KM 结果 matches 数组（必须带 shotId + mediaId/chunkId）
   * @param projectId 可选，日志里定位项目
   */
  static auditPreselectTopK(
    perQueryTopK: Record<string, string[]>,
    matches: any[],
    projectId?: string,
  ): { total: number; hit: number; hitRate: number } {
    if (!matches || matches.length === 0) return { total: 0, hit: 0, hitRate: 1 };
    let total = 0, hit = 0;
    for (const m of matches) {
      // ✅ 身份键统一：MatchResult 主键为 id（出生处 seg_N 全局唯一），审计也一律读 id
      const sid = String(m.id || '');
      const cid = String(m.mediaId || m.chunkId || '');
      const cand = perQueryTopK[sid];
      /** keepOriginalAudio 的原声定位匹配或纯未命中（cid 空）不在预选审计范围内，跳过 */
      if (!sid || !cid || !cand || m.keepOriginalAudio === true) continue;
      total++;
      if (cand.includes(cid)) hit++;
    }
    const hitRate = total === 0 ? 1 : hit / total;
    if (total > 0 && hitRate < 0.95) {
      AppLogger.warn(LOG_TAGS.AI_AGENT,
        `[preselectTopK/audit] ${projectId || ''} Top-K 命中率=${(hitRate * 100).toFixed(2)}% < 95%，共 ${total} 条语义匹配，其中 ${total - hit} 条最终匹配未进入预选 Top-K。建议增大 K 或调低 minDescCoverage。`);
    } else if (total > 0) {
      AppLogger.info(LOG_TAGS.AI_AGENT,
        `[preselectTopK/audit] ${projectId || ''} Top-K 命中率=${(hitRate * 100).toFixed(2)}%（${hit}/${total}），预选质量符合预期。`);
    }
    return { total, hit, hitRate };
  }

  /**
   * 组装单条匹配结果（原声定位 / 语义匹配 / 未匹配 共用出口）
   * @param q query 段落（含 shotId/text/audioDurationMs/keepOriginalAudio）
   * @param matched KM 匹配项或原声定位结果；null 表示未匹配
   * @param isOriginal 是否为已定位的原声段落（原声段落自带原声轨，固定高置信）
   */
  static buildMatchResult(
    q: { shotId: string; text: string; audioDurationMs: number; keepOriginalAudio?: boolean },
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
      return {
        /** ✅ 身份键统一：id 出生处即取段落唯一主键（buildMatchQueries 中 shotId 已收敛为 s.id），
         *  消费端一律读 id；shotId 保留同值兼容历史消费点。 */
        id: q.shotId,
        shotId: q.shotId,
        text: q.text,
        keepOriginalAudio: isOriginal,
        mediaType: 'video_chunk' as const,
        mediaId: matched.chunkId || matched.mediaId || '',
        score: isOriginal ? 0.95 : (matched.confidence || 0),
        thumbnail: matched.coverPath || '',
        chunkData: lightChunkData,
        audioDurationMs: matched.audioDurationMs || q.audioDurationMs,
        videoTimelineStartMs: matched.videoTimelineStartMs || 0,
        videoTimelineEndMs: matched.videoTimelineEndMs || 0,
        appliedSpeedFactor: matched.appliedSpeedFactor || 1.0,
        confirmed: isOriginal ? true : (matched.confidence || 0) >= 0.88,
      };
    }
    return {
      /** ✅ 身份键统一：id 出生处即取段落唯一主键（与上方命中分支同源） */
      id: q.shotId,
      shotId: q.shotId,
      text: q.text,
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
    };
  }

  /** 回退到原有的 CLIP 帧匹配模式 */
  private async fallbackFrameMatch(
    queries: { shotId: string; text: string; audioDurationMs: number; keepOriginalAudio?: boolean }[],
    cacheDir: string,
    onProgress: (p: number, s: string) => void
  ): Promise<any> {
    onProgress(50, '回退到 CLIP 帧匹配模式...');

    /** 查找帧画面目录 */
    let framesDir = cacheDir;
    const altDirs = [
      path.join(cacheDir, '..', 'vision-1', 'frames'),
      path.join(cacheDir, 'frames'),
    ];
    for (const dir of altDirs) {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png|bmp)$/i.test(f));
        if (files.length > 0) {
          framesDir = dir;
          break;
        }
      }
    }

    try {
      const result = await AIDaemon.getInstance().post('/api/match', {
        queries: queries.map(q => ({ shotId: q.shotId, text: q.text })),
        frames_dir: framesDir,
      });

      const matchData = result?.data || [];
      /** 回填索引：一次 O(M) 建 Map，后续查询 O(1) 替代 queries.map + matchData.find 的 O(N·M) */
      const fallbackMatchById = new Map<string, any>();
      for (const m of matchData) {
        const sid = (m as any)?.shotId;
        if (sid) fallbackMatchById.set(String(sid), m);
      }
      const matches = queries.map(q => {
        const matched = fallbackMatchById.get(q.shotId);
        const matchedFrame = matched?.matchedFrame || '';
        const thumbnail = matchedFrame ? path.join(framesDir, matchedFrame) : '';

        return {
          shotId: q.shotId,
          text: q.text,
          mediaType: 'frame' as const,
          mediaId: matchedFrame || '',
          score: matched ? 0.5 : 0,
          thumbnail,
          chunkData: null,
          audioDurationMs: q.audioDurationMs,
          videoTimelineStartMs: 0,
          videoTimelineEndMs: 0,
          appliedSpeedFactor: 1.0,
          confirmed: false,
        };
      });

      onProgress(100, '帧匹配完成（回退模式）');
      return { matches, segments: matchData };
    } catch (e: any) {
      AppLogger.error(LOG_TAGS.AI_AGENT, '镜头匹配服务调用失败', e);
      throw new Error('镜头匹配服务异常: ' + (e.message || '未知错误'));
    }
  }
}
