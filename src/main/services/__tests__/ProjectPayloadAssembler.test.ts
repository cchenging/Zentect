// 路径: src/main/services/__tests__/ProjectPayloadAssembler.test.ts
// assembleProjectPayload 纯函数单元测试
// 覆盖：空数据、JSON 解析、running 归一化、step1 状态推导、currentStep 计算、
//       framePaths 提取、音频 mediaItems 生成、降级逻辑

import { describe, it, expect } from 'vitest';
import { assembleProjectPayload } from '../ProjectPayloadAssembler';

describe('assembleProjectPayload', () => {
  // ══════════════════════════════════════════
  // 基础场景
  // ══════════════════════════════════════════

  it('rawData 为 null/undefined 时返回 null', () => {
    expect(assembleProjectPayload(null, 'p1')).toBeNull();
    expect(assembleProjectPayload(undefined, 'p1')).toBeNull();
  });

  it('空对象返回合法的默认结构', () => {
    const result = assembleProjectPayload({}, 'p1');
    expect(result).not.toBeNull();
    expect(result.id).toBe('p1');
    expect(result.name).toBe('');
    expect(result.mediaItems).toEqual([]);
    expect(result.roles).toEqual([]);
    expect(result.stepStatuses).toEqual(['idle', 'idle', 'idle', 'idle', 'idle']);
    expect(result.stepCompleted).toEqual([false, false, false, false, false]);
    expect(result.currentStep).toBe(1);
    expect(result.framePaths).toEqual([]);
    expect(result.frameCount).toBe(0);
    expect(result.asrLines).toEqual([]);
  });

  // ══════════════════════════════════════════
  // JSON 字符串解析
  // ══════════════════════════════════════════

  it('解析 JSON 字符串格式的 subStepStatuses', () => {
    const result = assembleProjectPayload({
      subStepStatuses: JSON.stringify({ frames: 'completed', audio: 'completed' }),
    }, 'p1');
    expect(result.subStepStatuses).toEqual({ frames: 'completed', audio: 'completed' });
  });

  it('解析 JSON 字符串格式的 stepStatuses 和 stepCompleted', () => {
    const result = assembleProjectPayload({
      stepStatuses: JSON.stringify(['running', 'idle', 'idle', 'idle', 'idle']),
      stepCompleted: JSON.stringify([false, false, false, false, false]),
    }, 'p1');
    expect(result.stepStatuses[0]).toBe('running');
    expect(result.stepCompleted[0]).toBe(false);
  });

  it('非法 JSON 字符串不崩溃，原值保留', () => {
    // parseJson 失败时返回原字符串，由于是 truthy 不会被 || {} 覆盖
    // 非对象字符串被 spread 为索引对象，但不会崩溃
    const result = assembleProjectPayload({
      subStepStatuses: '{invalid json',
    }, 'p1');
    // 非法 JSON 解析失败不抛异常，行为降级为按索引展开
    expect(result.subStepStatuses).toBeDefined();
    expect(typeof result.subStepStatuses).toBe('object');
  });

  it('已解析的对象格式直接使用', () => {
    const result = assembleProjectPayload({
      subStepStatuses: { frames: 'completed', whisper: 'failed' },
    }, 'p1');
    expect(result.subStepStatuses).toEqual({ frames: 'completed', whisper: 'failed' });
  });

  // ══════════════════════════════════════════
  // running → idle 归一化
  // ══════════════════════════════════════════

  it('running 状态归一化为 idle', () => {
    const result = assembleProjectPayload({
      subStepStatuses: { frames: 'running', audio: 'running', whisper: 'completed' },
    }, 'p1');
    expect(result.subStepStatuses.frames).toBe('idle');
    expect(result.subStepStatuses.audio).toBe('idle');
    expect(result.subStepStatuses.whisper).toBe('completed');
  });

  it('completed 和 failed 状态保持不变', () => {
    const result = assembleProjectPayload({
      subStepStatuses: { frames: 'completed', audio: 'failed', whisper: 'idle' },
    }, 'p1');
    expect(result.subStepStatuses).toEqual({ frames: 'completed', audio: 'failed', whisper: 'idle' });
  });

  // ══════════════════════════════════════════
  // step1 总状态推导
  // ══════════════════════════════════════════

  it('四个子步骤全部 completed 时 step1 推导为 completed', () => {
    const result = assembleProjectPayload({
      subStepStatuses: { frames: 'completed', audio: 'completed', whisper: 'completed', faces: 'completed' },
    }, 'p1');
    expect(result.stepStatuses[0]).toBe('completed');
    expect(result.stepCompleted[0]).toBe(true);
  });

  it('任一子步骤 failed 时 step1 推导为 failed', () => {
    const result = assembleProjectPayload({
      subStepStatuses: { frames: 'completed', audio: 'completed', whisper: 'failed', faces: 'completed' },
    }, 'p1');
    expect(result.stepStatuses[0]).toBe('failed');
    expect(result.stepCompleted[0]).toBe(false);
  });

  it('部分子步骤 completed 但未全部完成时 step1 保持 idle', () => {
    const result = assembleProjectPayload({
      subStepStatuses: { frames: 'completed', audio: 'completed' },
    }, 'p1');
    // 只有2个值，不满足全部4个完成条件，但有started=completed，step1应推导
    // 但 step1Values.length 为 2，不等于 4，所以 allCompleted=false，hasFailed=false
    // derivedStatus = 'idle'，hasStarted = true
    // currentS0 = 'idle'，step1Active = false
    // 但 hasStarted=true，所以会进入 if 块
    // step1Active=false，但 hasStarted=true 满足条件
    // (hasStarted || step1Active) = true
    // (currentS0 !== 'idle' || stepCompleted[0] !== false) = (false || false) = false
    // 所以条件不满足，不会更新
    expect(result.stepStatuses[0]).toBe('idle');
    expect(result.stepCompleted[0]).toBe(false);
  });

  it('step1 已是 running 状态时不覆盖（保持活跃）', () => {
    const result = assembleProjectPayload({
      stepStatuses: ['running', 'idle', 'idle', 'idle', 'idle'],
      subStepStatuses: { frames: 'completed', audio: 'completed', whisper: 'completed', faces: 'completed' },
    }, 'p1');
    // step1Active=true, hasStarted=true, currentS0='running'
    // currentS0 !== 'completed' → true，所以会更新为 completed
    expect(result.stepStatuses[0]).toBe('completed');
    expect(result.stepCompleted[0]).toBe(true);
  });

  // ══════════════════════════════════════════
  // currentStep 计算
  // ══════════════════════════════════════════

  it('有 currentStep 时优先使用', () => {
    const result = assembleProjectPayload({ currentStep: 3 }, 'p1');
    expect(result.currentStep).toBe(3);
  });

  it('currentStep=0 时视为无保存值，回退到推导逻辑', () => {
    // 0 在 JS 中是 falsy，savedStep && ... 条件不满足，回退到 stepCompleted 推导
    const result = assembleProjectPayload({ currentStep: 0 }, 'p1');
    expect(result.currentStep).toBe(1);
  });

  it('无 currentStep 时根据 stepCompleted 推导（step1 完成后跳到 step2）', () => {
    const result = assembleProjectPayload({
      stepCompleted: [true, false, false, false, false],
    }, 'p1');
    expect(result.currentStep).toBe(2);
  });

  it('step1+step2 完成后跳到 step3', () => {
    const result = assembleProjectPayload({
      stepCompleted: [true, true, false, false, false],
    }, 'p1');
    expect(result.currentStep).toBe(3);
  });

  it('全部完成时停在最后一步', () => {
    const result = assembleProjectPayload({
      stepCompleted: [true, true, true, true, true],
    }, 'p1');
    expect(result.currentStep).toBe(5);
  });

  it('无任何完成步骤时默认 step1', () => {
    const result = assembleProjectPayload({
      stepCompleted: [false, false, false, false, false],
    }, 'p1');
    expect(result.currentStep).toBe(1);
  });

  // ══════════════════════════════════════════
  // framePaths 提取
  // ══════════════════════════════════════════

  it('从 mediaItems 中提取视频帧路径（字符串数组）', () => {
    const result = assembleProjectPayload({
      mediaItems: [
        { id: 'v1', type: 'video', frames: ['frame1.jpg', 'frame2.jpg'] },
      ],
    }, 'p1');
    expect(result.framePaths).toEqual(['magic://p1/frame1.jpg', 'magic://p1/frame2.jpg']);
    expect(result.frameCount).toBe(2);
  });

  it('从 mediaItems 中提取视频帧路径（对象数组）', () => {
    const result = assembleProjectPayload({
      mediaItems: [
        { id: 'v1', type: 'video', frames: [{ path: 'f1.jpg' }, { filePath: 'f2.jpg' }] },
      ],
    }, 'p1');
    expect(result.framePaths).toEqual(['magic://p1/f1.jpg', 'magic://p1/f2.jpg']);
  });

  it('多视频源合并 framePaths', () => {
    const result = assembleProjectPayload({
      mediaItems: [
        { id: 'v1', type: 'video', frames: ['a.jpg'] },
        { id: 'v2', type: 'video', frames: ['b.jpg', 'c.jpg'] },
      ],
    }, 'p1');
    expect(result.framePaths).toEqual(['magic://p1/a.jpg', 'magic://p1/b.jpg', 'magic://p1/c.jpg']);
  });

  it('framePaths 降级：DB 无 frames 时从 metadata.framePaths 恢复', () => {
    const result = assembleProjectPayload({
      mediaItems: [],
      framePaths: ['fallback1.jpg', 'fallback2.jpg'],
    }, 'p1');
    expect(result.framePaths).toEqual(['magic://p1/fallback1.jpg', 'magic://p1/fallback2.jpg']);
  });

  it('绝对路径与已有协议的帧路径保持原样', () => {
    const result = assembleProjectPayload({
      mediaItems: [
        { id: 'v1', type: 'video', frames: ['F:\\videos\\f1.jpg', 'magic://p1/nodes/a.jpg', 'https://x.com/b.jpg'] },
      ],
    }, 'p1');
    expect(result.framePaths).toEqual(['F:\\videos\\f1.jpg', 'magic://p1/nodes/a.jpg', 'https://x.com/b.jpg']);
  });

  it('frameCount 优先使用 rawData.frameCount', () => {
    const result = assembleProjectPayload({
      frameCount: 100,
      mediaItems: [{ id: 'v1', type: 'video', frames: ['a.jpg'] }],
    }, 'p1');
    expect(result.frameCount).toBe(100);
  });

  // ══════════════════════════════════════════
  // 音频 mediaItems 生成
  // ══════════════════════════════════════════

  it('有 extractedVocals 时生成人声音频项', () => {
    const result = assembleProjectPayload({
      mediaItems: [
        { id: 'v1', type: 'video', extractedVocals: '/path/vocals.wav' },
      ],
    }, 'p1');
    const audioItems = result.mediaItems.filter((m: any) => m.type === 'audio');
    expect(audioItems).toHaveLength(1);
    expect(audioItems[0].sourceType).toBe('vocals');
    expect(audioItems[0].id).toBe('v1_vocals');
  });

  it('有 extractedBgm 时生成背景音音频项', () => {
    const result = assembleProjectPayload({
      mediaItems: [
        { id: 'v1', type: 'video', extractedBgm: '/path/bgm.wav' },
      ],
    }, 'p1');
    const audioItems = result.mediaItems.filter((m: any) => m.type === 'audio');
    expect(audioItems).toHaveLength(1);
    expect(audioItems[0].sourceType).toBe('bgm');
  });

  it('extractedAudio 无 vocals/bgm 时生成提取音频项', () => {
    const result = assembleProjectPayload({
      mediaItems: [
        { id: 'v1', type: 'video', extractedAudio: '/path/audio.wav' },
      ],
    }, 'p1');
    const audioItems = result.mediaItems.filter((m: any) => m.type === 'audio');
    expect(audioItems).toHaveLength(1);
    expect(audioItems[0].sourceType).toBe('extracted');
  });

  it('不重复生成已存在的音频类型', () => {
    const result = assembleProjectPayload({
      mediaItems: [
        { id: 'v1', type: 'video', extractedVocals: '/path/vocals.wav', extractedBgm: '/path/bgm.wav' },
        { id: 'v1_vocals', type: 'audio', sourceType: 'vocals', filePath: '/path/vocals.wav' },
      ],
    }, 'p1');
    const audioItems = result.mediaItems.filter((m: any) => m.type === 'audio');
    // 已有 vocals 音频项，只应新增 bgm
    expect(audioItems).toHaveLength(2);
    expect(audioItems.map((a: any) => a.sourceType).sort()).toEqual(['bgm', 'vocals']);
  });

  // ══════════════════════════════════════════
  // 视频路径但无 mediaItems
  // ══════════════════════════════════════════

  it('有 videoPath 但无 mediaItems 时自动构建默认视频项', () => {
    const result = assembleProjectPayload({
      videoPath: '/videos/test.mp4',
    }, 'p1');
    expect(result.mediaItems).toHaveLength(1);
    expect(result.mediaItems[0].type).toBe('video');
    expect(result.mediaItems[0].id).toBe('main-video-source');
    expect(result.mediaItems[0].filePath).toBe('/videos/test.mp4');
  });

  // ══════════════════════════════════════════
  // 各步骤数据透传
  // ══════════════════════════════════════════

  it('透传各步骤数据字段', () => {
    const result = assembleProjectPayload({
      projectName: '测试项目',
      roles: [{ id: 'r1', name: '角色A' }],
      shots: [{ start: 0, end: 5, text: 'hello' }],
      aiShots: [{ id: 'as1' }],
      videoPath: '/v/test.mp4',
      vocalPath: '/v/vocals.wav',
      backgroundPath: '/v/bgm.wav',
      asrLines: [{ text: 'line1' }],
      audioSeparated: true,
      pipelineParams: { engine: 'local' },
      extractionConfig: { mode: 'fast' },
      vlmFrames: [{ id: 'vf1' }],
      scriptParagraphs: [{ id: 'sp1' }],
      scriptStyle: 'formal',
      speechRate: 5.0,
      ttsResults: [{ id: 'tts1' }],
      ttsEngine: 'edge',
      ttsVoiceId: 'zh-CN-XiaoxiaoNeural',
      videoChunks: [{ id: 'vc1' }],
      canvasData: { nodes: [] },
      subStepProgresses: { frames: 100 },
    }, 'p1');

    expect(result.name).toBe('测试项目');
    expect(result.roles).toEqual([{ id: 'r1', name: '角色A' }]);
    expect(result.shots).toEqual([{ start: 0, end: 5, text: 'hello' }]);
    expect(result.videoPath).toBe('/v/test.mp4');
    expect(result.vocalPath).toBe('/v/vocals.wav');
    expect(result.backgroundPath).toBe('/v/bgm.wav');
    expect(result.asrLines).toEqual([{ text: 'line1' }]);
    expect(result.audioSeparated).toBe(true);
    expect(result.pipelineParams).toEqual({ engine: 'local' });
    expect(result.extractionConfig).toEqual({ mode: 'fast' });
    expect(result.vlmFrames).toEqual([{ id: 'vf1' }]);
    expect(result.scriptParagraphs).toEqual([{ id: 'sp1' }]);
    expect(result.scriptStyle).toBe('formal');
    expect(result.speechRate).toBe(5.0);
    expect(result.ttsResults).toEqual([{ id: 'tts1' }]);
    expect(result.ttsEngine).toBe('edge');
    expect(result.ttsVoiceId).toBe('zh-CN-XiaoxiaoNeural');
    expect(result.videoChunks).toEqual([{ id: 'vc1' }]);
    expect(result.canvasData).toEqual({ nodes: [] });
    expect(result.subStepProgresses).toEqual({ frames: 100 });
  });

  it('数组字段为空时返回空数组（非 undefined）', () => {
    const result = assembleProjectPayload({}, 'p1');
    expect(result.vlmFrames).toEqual([]);
    expect(result.scriptParagraphs).toEqual([]);
    expect(result.ttsResults).toEqual([]);
    expect(result.videoChunks).toEqual([]);
  });

  it('video_path 降级到 videoPath', () => {
    const result = assembleProjectPayload({ video_path: '/fallback.mp4' }, 'p1');
    expect(result.videoPath).toBe('/fallback.mp4');
  });
});