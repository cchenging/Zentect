/**
 * @deprecated 自 2026-07-05 起废弃，由 PipelineEngine + Step1MaterialStrategy 替代。
 * JobScheduler 已迁移至 PipelineEngine.executePipeline()。
 * 本文件保留仅为历史参考，将在后续版本中删除。
 */
import { ITextExtractor } from './strategies/IExtractor';
import { VideoProcessor } from './media/VideoProcessor';
import { AudioProcessor } from './media/AudioProcessor';
import { VisionProcessor } from './media/VisionProcessor';
import { MediaEngine } from './mediaEngine';
import { PathManager } from '../utils/pathManager';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../infra/logger/LogConstants';
import { AppError, ErrorCode } from '../../infra/error/AppError';

import * as path from 'path';
import * as fs from 'fs';

export class ExtractionPipeline {
    private textExtractor: ITextExtractor;
    
    private onProgressCallback?: (percent: number, text: string) => void;
    private currentMediaId: string = 'UNKNOWN';
    private abortSignal?: AbortSignal;

    constructor(textExtractor: ITextExtractor) {
        this.textExtractor = textExtractor;
    }

    /** 管线状态流转：检查中止信号、记录日志、推送进度回调 */
    private transition(stateCode: string, progress: number, logMsg: string, nodeType: string = 'NODE_ENTER') {
        if (this.abortSignal?.aborted) {
            throw new AppError(ErrorCode.SYS_UNKNOWN, 'TASK_ABORTED');
        }
        const logPrefix = nodeType === 'NODE_SUCCESS' ? '[NODE_SUCCESS]' : 
                         nodeType === 'NODE_FATAL' ? '[NODE_FATAL]' : 
                         nodeType === 'NODE_DOWNGRADE' ? '[NODE_DOWNGRADE]' : '[NODE_ENTER]';
        AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `${logPrefix} ${logMsg}`, { mediaId: this.currentMediaId, progress: `${progress}%` });
        this.onProgressCallback?.(progress, stateCode);
    }

    /** 执行完整的媒体提取管线：抽帧→音频分离→语音识别→人脸扫描→语义索引 */
    public async execute(
        filePath: string, mediaDir: string, framesDir: string, mediaId: string, projectId: string,
        inPoint?: number, outPoint?: number,
        onProgress?: (percent: number, text: string) => void,
        signal?: AbortSignal,
        config: any = {}
    ) {
        this.onProgressCallback = onProgress;
        this.currentMediaId = mediaId;
        this.abortSignal = signal;

        // 💥 修复防御：防止 config.frames 是 undefined 导致的读取崩溃
        // 💥 关键修复：audio/whisper/faces 也需要检查 enabled 字段，
        // 否则 { enabled: false } 不等于 false，导致单独重试抽帧时其他子业务也执行
        const runFrames = config.frames !== false &&
            (typeof config.frames === 'boolean' ? config.frames : (config.frames?.enabled ?? true));
        const runAudio = config.audio !== false &&
            (typeof config.audio === 'boolean' ? config.audio : (config.audio?.enabled ?? true));
        const runFaces = config.faces !== false &&
            (typeof config.faces === 'boolean' ? config.faces : (config.faces?.enabled ?? true));
        const runWhisper = config.whisper !== false &&
            (typeof config.whisper === 'boolean' ? config.whisper : (config.whisper?.enabled ?? true));

        try {
            this.transition('TASK_INIT', 5, 'Initializing pipeline context and environment');
            const rawAudioPath = path.join(mediaDir, `audio_${mediaId}_16k.wav`);
            
            const facesBaseDir = PathManager.getProjectExtractionsDir(projectId, 'faces');
            const facesDir = path.join(facesBaseDir, mediaId);
            if (!fs.existsSync(facesDir)) fs.mkdirSync(facesDir, { recursive: true });

            let validFrames: string[] = [];
            let hasAudio: boolean | string = true; 
            let vocalsPath: string | undefined = undefined;
            let bgmPath: string | undefined = undefined;
            let targetAudio = rawAudioPath;
            let whisperResult = '';
            
            // 🌟 战术级优化：双子星并行执行！抽帧与音频分离同时启动
            const hasVideo = true;
            
            try {
                const [_frameResult, _audioResult] = await Promise.all([
                    // 轨道 A：视频视觉链路
                    (async () => {
                        if (hasVideo && runFrames) {
                            this.transition('TASK_EXTRACT_FRAMES', 10, 'Launching FFmpeg core frame extraction engine');
                            try {
                                // 💥 传入高阶策略配置对象，从 config.frames 中提取战术指令
                                const framesConfig = typeof config.frames === 'object' ? config.frames : {};
                                const strategy = framesConfig.mode || config.frameStrategy || 'VLM_OPTIMIZED';
                                let telemetryResult = await VideoProcessor.extractFrames(filePath, framesDir, mediaId, {
                                    inPoint,
                                    outPoint,
                                    abortSignal: signal,
                                    strategy,
                                    fps: framesConfig.fps || config.frameFps || 2,
                                    sceneThreshold: framesConfig.sceneThreshold || 0.28,
                                    minFrameInterval: framesConfig.minFrameInterval || 4,
                                    scale: framesConfig.scale || 1024,
                                    quality: framesConfig.quality || 3,
                                    timePoint: framesConfig.timePoint
                                });
                                
                                /** VLM/scene 模式帧数过少时自动降级到 UNIFORM_FPS 模式重抽 */
                                const needsFallback = (strategy === 'VLM_OPTIMIZED' || strategy === 'scene')
                                    && telemetryResult.files.length < 3;
                                if (needsFallback) {
                                    AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[NODE_DOWNGRADE] VLM/Scene mode produced too few frames, falling back to UNIFORM_FPS', {
                                        mediaId: this.currentMediaId, frameCount: telemetryResult.metrics.frameCount
                                    });
                                    telemetryResult = await VideoProcessor.extractFrames(filePath, framesDir, mediaId, {
                                        inPoint,
                                        outPoint,
                                        abortSignal: signal,
                                        strategy: 'UNIFORM_FPS',
                                        fps: framesConfig.fps || config.frameFps || 2,
                                        scale: framesConfig.scale || 1024,
                                        quality: framesConfig.quality || 3
                                    });
                                }
                                
                                validFrames = telemetryResult.files;

                                // 💥 向雷达系统抛出工业级遥测日志
                                AppLogger.info(LOG_TAGS.MEDIA_ENGINE, '[NODE_SUCCESS] Frame extraction completed', {
                                    mediaId: this.currentMediaId,
                                    metrics: telemetryResult.metrics
                                });
                                
                                // 💥 发射帧提取完成信号
                                this.transition('extracting_frames', 20, 'Frame extraction completed');
                                
                                return telemetryResult;
                            } catch (e: any) {
                                AppLogger.error(LOG_TAGS.MEDIA_ENGINE, '[NODE_FATAL] Video frame extraction failed', { mediaId: this.currentMediaId, error: e });
                                this.transition('error', 20, 'Frame extraction failed', 'NODE_FATAL');
                                return { files: [] };
                            }
                        }
                        return { files: [] };
                    })(),
                    
                    // 轨道 B：音频语义链路
                    (async () => {
                        if (runAudio) {
                            this.transition('TASK_EXTRACT_AUDIO', 25, 'Launching audio separation engine');
                            // 推送音频分离开始进度
                            this.transition('separating_audio', 15, 'Starting audio separation');
                            try {
                                hasAudio = await (AudioProcessor as any).separateAudio(filePath, rawAudioPath, mediaId, inPoint, outPoint, signal);
                            } catch (e) {
                                AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[NODE_DOWNGRADE] No valid audio track detected, running in silent mode', { mediaId: this.currentMediaId });
                                hasAudio = false;
                            }

                            if (hasAudio) {
                                this.transition('TASK_SEPARATE_AUDIO_MATRIX', 35, 'Requesting Demucs vocal isolation microservice');
                                try {
                                    const separated = await (AudioProcessor as any).separateVocalsBgm(rawAudioPath, mediaDir);
                                    if (separated && separated.vocals) {
                                        targetAudio = separated.vocals;
                                        vocalsPath = separated.vocals;
                                        bgmPath = separated.bgm;
                                    }
                                    // 推送音频分离完成进度
                                    this.transition('audio_separated', 30, 'Audio separation completed');
                                    return separated;
                                } catch (e: any) {
                                    AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[NODE_DOWNGRADE] Demucs service unresponsive. Falling back to original audio track.', { mediaId: this.currentMediaId, error: e.message });
                                }
                            }
                        }
                        return null;
                    })()
                ]);
            } catch (error: any) {
                AppLogger.error(LOG_TAGS.MEDIA_ENGINE, '[NODE_FATAL] Parallel execution failed', { mediaId: this.currentMediaId, error: error });
                throw error;
            }

            if (hasAudio && runWhisper && fs.existsSync(targetAudio)) {
                this.transition('TASK_WHISPER', 50, 'Igniting Whisper/SenseVoice multilingual engine');
                
                // 💥 宪法修正：将 targetLanguage 映射为 SenseVoice 识别的简写
                const langMap: Record<string, string> = { 'zh-CN': 'zh', 'en-US': 'en', 'ja-JP': 'ja', 'ko-KR': 'ko' };
                const targetLang = langMap[config.targetLanguage] || 'auto';
                try {
                    const textResult = await (this.textExtractor as any).transcribe(
                        targetAudio,
                        mediaDir,
                        mediaId,
                        targetLang // 💥 向 Python 传递正确的语种代码
                    );
                    whisperResult = textResult.whisperJsonPath || '';
                    
                    // 推送语音识别完成进度
                    this.transition('parsing_text', 60, 'Whisper transcription completed');
                } catch (e: any) {
                    /** ASR 失败不阻断管线，降级跳过语音识别 */
                    AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[NODE_DOWNGRADE] ASR service failed, skipping transcription', { mediaId: this.currentMediaId, error: e.message });
                    this.transition('parsing_text', 60, 'ASR skipped due to service failure', 'NODE_DOWNGRADE');
                }
            }

            // 💥 --- 抽取角色人脸 ---
            let roles: any[] = [];
            let clustersMap: Record<string, string> = {}; // 新增：保存人脸到群组的映射
            
            // 💥 终极修复：增加 validFrames.length > 0 的绝对防御！
            if (runFaces) {
                if (validFrames.length === 0) {
                    // 容错降级：如果抽帧引擎（特别是智能转场模式下）一张图都没抽出来，
                    // 直接跳过人脸识别，绝不向 Python 发送空数组导致 422 崩溃！
                    AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[NODE_DOWNGRADE] No frames extracted, skipping face scan automatically');
                } else {
                    this.transition('TASK_SCAN_FACES', 70, 'Igniting multimodal vision analysis engine');
                    try {
                        roles = await VisionProcessor.scanFaces(validFrames, facesDir);
                        
                        if (roles.length > 0) {
                            this.transition('TASK_CLUSTER_FACES', 80, 'Running HDBSCAN unsupervised face clustering');
                            clustersMap = await VisionProcessor.clusterFaces(mediaId, roles);
                        }
                    } catch (e: any) {
                        AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[NODE_DOWNGRADE] Vision service unresponsive, skipping face scan', { mediaId: this.currentMediaId, error: e.message });
                        this.transition('error', 80, 'Vision service failed', 'NODE_FATAL');
                    }
                }
            }

            this.transition('TASK_ASSEMBLE', 85, 'Activating MediaEngine temporal alignment and data assembly center');
            
            const finalWhisperPath = whisperResult ? whisperResult.replace('.json', '') : path.join(mediaDir, `whisper_${mediaId}`);
            if (!fs.existsSync(finalWhisperPath + '.json')) {
                fs.writeFileSync(finalWhisperPath + '.json', JSON.stringify({ transcription: [] }), 'utf-8');
            }

            // 💥 核心架构升级：过滤并归纳真正的 "角色 (Role)" 而非零散的脸
            const finalRoles: any[] = [];
            const processedClusters = new Set<string>();
            for (const r of roles) {
                const cid = clustersMap[r.systemId] || 'role_unknown';
                if (cid !== 'role_unknown' && cid !== '-1' && !processedClusters.has(cid)) {
                    processedClusters.add(cid);
                    finalRoles.push({
                        id: `${mediaId}_${cid}`, 
                        systemId: cid, // 例：role_0
                        name: `角色_${cid.split('_')[1] || cid}`,
                        avatar: r.avatarPath, // 使用该聚类被发现的第一张脸作为头像
                        mergedRoles: []
                    });
                }
            }

            // 调用底层的古老方法进行时序组装
            const dto = await MediaEngine.assemblePipelineData(finalWhisperPath, framesDir, mediaId, inPoint, finalRoles);
            let assembledShots = dto.shots;

            if (assembledShots.length === 0) {
                AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[NODE_DOWNGRADE] No parseable data, triggering frontend white screen protection', { mediaId: this.currentMediaId });
                assembledShots.push({
                    id: `shot_${Date.now()}_0`, mediaId: mediaId, imagePath: '', text: '无可解析的内容',
                    start: 0, end: 5, duration: 5
                });
            } else {
                // 💥 核心数据升维：把 clusterId 反向注入到每一个镜头中，为前端"一键找人"建立羁绊！
                assembledShots = assembledShots.map(shot => {
                    if (!shot.imagePath) return { ...shot, clusterIds: [] };
                    const frameName = path.basename(shot.imagePath, '.jpg'); 
                    const cid = clustersMap[frameName];
                    return {
                        ...shot,
                        clusterIds: (cid && cid !== 'role_unknown' && cid !== '-1') ? [cid] : []
                    };
                });
            }

            // CLIP 语义提取 + 语义流生成（降级安全：任何失败都不影响主流程）
            if (assembledShots.length > 0) {
                 this.transition('TASK_EXTRACT_SEMANTICS', 90, 'Building high-dimensional CLIP semantic index');
                 try {
                     await VisionProcessor.extractSemantics(mediaId, assembledShots);

                     this.transition('TASK_SEMANTIC_FLOW', 95, 'Generating temporal semantic flow via Vision LLM');
                     assembledShots = await VisionProcessor.generateSemanticFlow(assembledShots);
                 } catch (e: any) {
                     AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[NODE_DOWNGRADE] Semantic extraction degrading, continuing without CLIP index', { mediaId: this.currentMediaId, error: e.message });
                 }
            }

            this.transition('TASK_SUCCESS', 100, 'Pipeline extraction completed successfully', 'NODE_SUCCESS');
            
            return {
                type: 'extract_media', mediaId, roles: finalRoles, shots: assembledShots,
                frames: validFrames, audioPath: hasAudio ? rawAudioPath : undefined,
                vocalsPath, bgmPath, text: ''
            };
        } catch (error: any) {
            if (error.message === 'TASK_ABORTED' || (error instanceof AppError && error.message === 'TASK_ABORTED')) {
                AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[NODE_DOWNGRADE] Received abort signal, safe shutdown.', { mediaId: this.currentMediaId });
                this.transition('error', 0, 'Task aborted', 'NODE_FATAL');
                throw new AppError(ErrorCode.SYS_UNKNOWN, 'TASK_ABORTED');
            }
            AppLogger.error(LOG_TAGS.MEDIA_ENGINE, '[NODE_FATAL] Pipeline execution crashed', { mediaId: this.currentMediaId, error: error?.message || String(error) });
            this.transition('error', 0, 'Pipeline crashed', 'NODE_FATAL');
            throw error instanceof AppError ? error : new AppError(ErrorCode.AI_PROCESS_FAILED, error.message);
        }
    }
}
