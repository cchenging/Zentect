import { ITextExtractor } from './strategies/IExtractor';
import { VideoProcessor } from './media/VideoProcessor';
import { AudioProcessor } from './media/AudioProcessor';
import { VisionProcessor } from './media/VisionProcessor';
import { MediaEngine } from './mediaEngine';
import { PathManager } from '../utils/pathManager';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../shared/utils/LogConstants';
import { AppError, ErrorCode } from '../../shared/utils/AppError';
import { MainNotifier } from '../core/MainNotifier';
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
        const runFrames = config.frames !== false &&
            (typeof config.frames === 'boolean' ? config.frames : (config.frames?.enabled ?? true));
        const runAudio = config.audio !== false;
        const runFaces = config.faces !== false;
        const runWhisper = config.whisper !== false;

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
                            // 💥 向遥测系统发射进度信号
                            MainNotifier.sendTaskProgress(this.currentMediaId, 'extracting_frames', 10, 'extracting_frames');
                            try {
                                // 💥 传入高阶策略配置对象，从 config.frames 中提取战术指令
                                const framesConfig = typeof config.frames === 'object' ? config.frames : {};
                                const telemetryResult = await VideoProcessor.extractFrames(filePath, framesDir, mediaId, {
                                    inPoint,
                                    outPoint,
                                    abortSignal: signal,
                                    strategy: framesConfig.mode || config.frameStrategy || 'scene',
                                    fps: framesConfig.fps || config.frameFps || 1,
                                    sceneThreshold: framesConfig.sceneThreshold || 0.3
                                });
                                
                                validFrames = telemetryResult.files;

                                // 💥 向雷达系统抛出工业级遥测日志
                                AppLogger.info(LOG_TAGS.MEDIA_ENGINE, '[NODE_SUCCESS] Frame extraction completed', {
                                    mediaId: this.currentMediaId,
                                    metrics: telemetryResult.metrics
                                });
                                
                                // 💥 发射帧提取完成信号
                                MainNotifier.sendTaskProgress(this.currentMediaId, 'extracting_frames', 20, 'extracting_frames');
                                
                                return telemetryResult;
                            } catch (e: any) {
                                AppLogger.error(LOG_TAGS.MEDIA_ENGINE, '[NODE_FATAL] Video frame extraction failed', { mediaId: this.currentMediaId, error: e });
                                MainNotifier.sendTaskProgress(this.currentMediaId, 'error', 20, 'error');
                                return { files: [] };
                            }
                        }
                        return { files: [] };
                    })(),
                    
                    // 轨道 B：音频语义链路
                    (async () => {
                        if (runAudio) {
                            this.transition('TASK_EXTRACT_AUDIO', 25, 'Launching audio separation engine');
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
                // 💥 向遥测系统发射台词提取信号
                MainNotifier.sendTaskProgress(this.currentMediaId, 'parsing_text', 50, 'parsing_text');
                
                // 💥 宪法修正：将 targetLanguage 映射为 SenseVoice 识别的简写
                const langMap: Record<string, string> = { 'zh-CN': 'zh', 'en-US': 'en', 'ja-JP': 'ja', 'ko-KR': 'ko' };
                const targetLang = langMap[config.targetLanguage] || 'auto';
                const textResult = await (this.textExtractor as any).transcribe(
                    targetAudio,
                    mediaDir,
                    mediaId,
                    targetLang // 💥 向 Python 传递正确的语种代码
                );
                whisperResult = textResult.whisperJsonPath || '';
                
                // 💥 发射台词提取完成信号
                MainNotifier.sendTaskProgress(this.currentMediaId, 'parsing_text', 60, 'parsing_text');
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
                    // 💥 向遥测系统发射视觉索引信号
                    MainNotifier.sendTaskProgress(this.currentMediaId, 'indexing_vision', 70, 'indexing_vision');
                    try {
                        roles = await (VisionProcessor as any).scanFaces(validFrames, facesDir);
                        
                        // 💥 新增战役节点：人脸聚类！
                        if (roles.length > 0) {
                            this.transition('TASK_CLUSTER_FACES', 80, 'Running HDBSCAN unsupervised face clustering');
                            clustersMap = await (VisionProcessor as any).clusterFaces(mediaId, roles);
                            // 💥 发射视觉索引完成信号
                            MainNotifier.sendTaskProgress(this.currentMediaId, 'indexing_vision', 80, 'indexing_vision');
                        }
                    } catch (e: any) {
                        AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[NODE_DOWNGRADE] Vision service unresponsive, skipping face scan', { mediaId: this.currentMediaId, error: e.message });
                        MainNotifier.sendTaskProgress(this.currentMediaId, 'error', 80, 'error');
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

            // 💥 终极战役节点：提取多模态 CLIP 语义！
            if (assembledShots.length > 0) {
                 this.transition('TASK_EXTRACT_SEMANTICS', 90, 'Building high-dimensional CLIP semantic index');
                 // 💥 发射 CLIP 语义提取信号
                 MainNotifier.sendTaskProgress(this.currentMediaId, 'indexing_vision', 90, 'indexing_vision');
                 await (VisionProcessor as any).extractSemantics(mediaId, assembledShots);

                 // =========================================================================
                 // 🌟 宪法级升维：注入 video-analyzer 级别的上下文语义流
                 // =========================================================================
                 this.transition('TASK_SEMANTIC_FLOW', 95, 'Generating temporal semantic flow via Vision LLM');
                 MainNotifier.sendTaskProgress(this.currentMediaId, 'analyzing_flow', 95, 'analyzing_flow');
                 
                 // 重写 assembledShots，为其注入 semanticDescription 字段
                 assembledShots = await (VisionProcessor as any).generateSemanticFlow(assembledShots);
                 // =========================================================================
            }

            this.transition('TASK_SUCCESS', 100, 'Pipeline extraction completed successfully', 'NODE_SUCCESS');
            // 💥 发射任务完成信号
            MainNotifier.sendTaskProgress(this.currentMediaId, 'completed', 100, 'completed');
            
            return {
                type: 'extract_media', mediaId, roles: finalRoles, shots: assembledShots,
                frames: validFrames, audioPath: hasAudio ? rawAudioPath : undefined,
                vocalsPath, bgmPath, text: ''
            };
        } catch (error: any) {
            if (error.message === 'TASK_ABORTED' || (error instanceof AppError && error.message === 'TASK_ABORTED')) {
                AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[NODE_DOWNGRADE] Received abort signal, safe shutdown.', { mediaId: this.currentMediaId });
                MainNotifier.sendTaskProgress(this.currentMediaId, 'error', 0, 'error');
                throw new AppError(ErrorCode.SYS_UNKNOWN, 'TASK_ABORTED');
            }
            AppLogger.error(LOG_TAGS.MEDIA_ENGINE, '[NODE_FATAL] Pipeline execution crashed', { mediaId: this.currentMediaId, error: error });
            MainNotifier.sendTaskProgress(this.currentMediaId, 'error', 0, 'error');
            throw error instanceof AppError ? error : new AppError(ErrorCode.AI_PROCESS_FAILED, error.message);
        }
    }
}
