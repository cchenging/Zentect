// Module: pipeline/step4-tts - 端到端集成测试
// 复现 Container.tsx 的 handleSynthesize 调用链，验证 scriptShots 文案和 voiceId 是否正确传递
// 排查用户反馈：「配音的文案不是生成的」+「全部分段都是一个音」

import { describe, it, expect, vi, beforeEach } from 'vitest';

// === Mock 依赖 ===

vi.mock('../../../../main/engine/config/ProviderManager', () => ({
  ProviderManager: {
    getTTSConfig: vi.fn(() => ({ provider: 'edge' })),
  },
}));

vi.mock('../../../../main/core/AppLogger', () => ({
  AppLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../../infra/logger/LogConstants', () => ({
  LOG_TAGS: { AI_AGENT: 'AI_AGENT' },
}));

vi.mock('../../../../main/engine/TTSEngine', () => ({
  ttsEngine: {
    generateTTS: vi.fn(),
  },
}));

// 🎵 P2 声画同步：mock ffprobe 时长读取链路（child_process.spawn 模拟输出真实时长 3.5 秒，fs.existsSync 恒真）
vi.mock('../../../../main/utils/pathManager', () => ({
  PathManager: { getBinPath: vi.fn(() => 'ffprobe.exe') },
}));

vi.mock('fs', async () => ({
  ...(await vi.importActual('fs') as any),
  existsSync: vi.fn(() => true),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const listeners: Record<string, ((...args: any[]) => void)[]> = {};
    const child: any = {
      stdout: {
        on: (ev: string, cb: any) => {
          listeners[`stdout:${ev}`] = [...(listeners[`stdout:${ev}`] || []), cb];
        },
        emit: (ev: string, data?: any) => {
          (listeners[`stdout:${ev}`] || []).forEach((cb) => cb(data));
        },
      },
      on: (ev: string, cb: any) => {
        listeners[ev] = [...(listeners[ev] || []), cb];
      },
      emit: (ev: string, arg?: any) => {
        (listeners[ev] || []).forEach((cb) => cb(arg));
      },
      kill: vi.fn(),
    };
    // 模拟 ffprobe 成功输出真实时长 3.5 秒（stdout data + close code 0）
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from('3.5'));
      child.emit('close', 0);
    }, 0);
    return child;
  }),
}));

import { ttsEngine } from '../../../../main/engine/TTSEngine';
import { TTSStrategy } from '../backend/Strategy';
import { useStep3Store } from '../../stores/useStep3Store';
import { useStep4Store } from '../../stores/useStep4Store';

// 复现 Container.tsx 的 STEP_SEQUENCES[4] 构造逻辑
const buildStep4Sequence = (step3State: any, step4State: any, speechRate: number, mediaPath: string) => [{
  nodeId: 'tts-1',
  actionType: 'tts-synthesize',
  label: '配音合成',
  dependsOn: [],
  mergedInputs: {},
  // Container.tsx 中 ...node 后再覆盖 params
  params: {
    ttsEngine: step4State.ttsEngine || 'edge',
    voiceId: step4State.ttsVoiceId || '',
    speechRate,
    mediaPath,
    scriptShots: step3State.scriptParagraphs || [],
  },
}];

describe('Step4 TTS 端到端集成测试', () => {
  let strategy: TTSStrategy;
  const mockGenerateTTS = vi.mocked(ttsEngine.generateTTS);

  beforeEach(() => {
    strategy = new TTSStrategy();
    vi.clearAllMocks();
    // 重置 store 到初始状态
    useStep3Store.getState().setScriptParagraphs([]);
    useStep4Store.setState({ ttsEngine: 'edge', ttsVoiceId: '', ttsProgress: 0, ttsResults: [] });
  });

  it('案例1：step3 生成3段解说词，step4 应逐段合成并传递正确文案', async () => {
    // 模拟 step3 生成的解说词（含 breakLongParagraphs 切分后的字段）
    const step3Paragraphs = [
      { id: 'para_1', type: 'narration' as const, startMs: 0, durationMs: 1500, text: '死死盯住冰鱼！', shotId: 'shot_1', duration: 1.5, emotion: 'tense', editing: false },
      { id: 'para_2', type: 'narration' as const, startMs: 1500, durationMs: 1800, text: '眼神杀气顿显！', shotId: 'shot_2', duration: 1.8, emotion: 'angry', editing: false },
      { id: 'para_3', type: 'narration' as const, startMs: 3300, durationMs: 2500, text: '这把刀，他早就握紧了。', shotId: 'shot_3', duration: 2.5, emotion: 'cold', editing: false },
    ];
    useStep3Store.getState().setScriptParagraphs(step3Paragraphs);
    useStep4Store.setState({ ttsEngine: 'edge', ttsVoiceId: 'zh-CN-XiaoxiaoNeural' });

    const step3State = useStep3Store.getState();
    const step4State = useStep4Store.getState();
    const sequence = buildStep4Sequence(step3State, step4State, 1.0, '/video/test.mp4');

    // 模拟 BaseNodeStrategy.execute 把 task.params 传给 performTask
    mockGenerateTTS.mockResolvedValue('/cache/tts_edge_001.wav');

    const result = await strategy.performTask(
      sequence[0].params,
      { bus: new Map() } as any,
      '/cache',
      vi.fn(),
    );

    // ✅ 断言1：3段全部成功
    expect(result.successCount).toBe(3);
    expect(result.failCount).toBe(0);

    // ✅ 断言2：generateTTS 被调用3次，每次的 text 是 step3 的解说词
    expect(mockGenerateTTS).toHaveBeenCalledTimes(3);
    expect(mockGenerateTTS).toHaveBeenNthCalledWith(1, '死死盯住冰鱼！', 'edge', '/cache', 'zh-CN-XiaoxiaoNeural', 1.0);
    expect(mockGenerateTTS).toHaveBeenNthCalledWith(2, '眼神杀气顿显！', 'edge', '/cache', 'zh-CN-XiaoxiaoNeural', 1.0);
    expect(mockGenerateTTS).toHaveBeenNthCalledWith(3, '这把刀，他早就握紧了。', 'edge', '/cache', 'zh-CN-XiaoxiaoNeural', 1.0);

    // ✅ 断言3：每段返回独立的 audioPath
    expect(result.shots[0].audioPath).toBe('/cache/tts_edge_001.wav');
  });

  it('案例2：用户选的音色 voiceId 应原样传递给后端', async () => {
    // 验证 voiceId 不被前端篡改，原样透传给 generateTTS
    useStep3Store.getState().setScriptParagraphs([
      { id: 'p1', type: 'narration', startMs: 0, durationMs: 2000, text: '测试文案', shotId: 's1', duration: 2, editing: false },
    ]);
    useStep4Store.setState({ ttsEngine: 'edge', ttsVoiceId: 'zh-CN-YunxiNeural' });

    const step3State = useStep3Store.getState();
    const step4State = useStep4Store.getState();
    const sequence = buildStep4Sequence(step3State, step4State, 1.0, '/video.mp4');

    mockGenerateTTS.mockResolvedValue('/cache/yunxi.wav');
    await strategy.performTask(sequence[0].params, { bus: new Map() } as any, '/cache', vi.fn());

    // ✅ 验证：voiceId='zh-CN-YunxiNeural' 被原样传给 generateTTS
    expect(mockGenerateTTS).toHaveBeenCalledWith('测试文案', 'edge', '/cache', 'zh-CN-YunxiNeural', 1.0);
  });

  it('案例3：step3 store 为空时，step4 应返回 _failed 而不是用其他文案合成', async () => {
    // 排查「配音的文案不是生成的」—— 验证 step3 空时不会用 placeholder 合成
    useStep3Store.getState().setScriptParagraphs([]);
    useStep4Store.setState({ ttsEngine: 'edge', ttsVoiceId: 'zh-CN-XiaoxiaoNeural' });

    const step3State = useStep3Store.getState();
    const step4State = useStep4Store.getState();
    const sequence = buildStep4Sequence(step3State, step4State, 1.0, '/video.mp4');

    const result = await strategy.performTask(
      sequence[0].params,
      { bus: new Map() } as any,
      '/cache',
      vi.fn(),
    );

    // ✅ 应返回 _failed，绝不调用 generateTTS（不会用 placeholder 文案合成）
    expect(result._failed).toBe(true);
    expect(result._error).toContain('未找到前置剧本');
    expect(mockGenerateTTS).not.toHaveBeenCalled();
  });

  it('案例4：step3 store 含空 text 段落时，应被过滤不参与合成', async () => {
    // 排查「文案不对」—— 验证空文本段落不会进入合成
    useStep3Store.getState().setScriptParagraphs([
      { id: 'p1', type: 'narration', startMs: 0, durationMs: 2000, text: '有效文案', shotId: 's1', duration: 2, editing: false },
      { id: 'p2', type: 'narration', startMs: 2000, durationMs: 2000, text: '', shotId: 's2', duration: 2, editing: false },
      { id: 'p3', type: 'narration', startMs: 4000, durationMs: 2000, text: '   ', shotId: 's3', duration: 2, editing: false },
      { id: 'p4', type: 'narration', startMs: 6000, durationMs: 2000, text: '第二段有效文案', shotId: 's4', duration: 2, editing: false },
    ]);
    useStep4Store.setState({ ttsEngine: 'edge', ttsVoiceId: 'zh-CN-XiaoxiaoNeural' });

    const step3State = useStep3Store.getState();
    const step4State = useStep4Store.getState();
    const sequence = buildStep4Sequence(step3State, step4State, 1.0, '/video.mp4');

    mockGenerateTTS.mockResolvedValue('/cache/edge.wav');
    const result = await strategy.performTask(sequence[0].params, { bus: new Map() } as any, '/cache', vi.fn());

    // ✅ 只有2段有效文案进入合成
    expect(result.successCount).toBe(2);
    expect(mockGenerateTTS).toHaveBeenCalledTimes(2);
    expect(mockGenerateTTS).toHaveBeenNthCalledWith(1, '有效文案', 'edge', '/cache', 'zh-CN-XiaoxiaoNeural', 1.0);
    expect(mockGenerateTTS).toHaveBeenNthCalledWith(2, '第二段有效文案', 'edge', '/cache', 'zh-CN-XiaoxiaoNeural', 1.0);
  });

  it('案例5：语速参数应正确传递给 generateTTS', async () => {
    // 排查「语速调节不生效」
    useStep3Store.getState().setScriptParagraphs([
      { id: 'p1', type: 'narration', startMs: 0, durationMs: 2000, text: '语速测试', shotId: 's1', duration: 2, editing: false },
    ]);
    useStep4Store.setState({ ttsEngine: 'edge', ttsVoiceId: 'zh-CN-XiaoxiaoNeural' });

    const step3State = useStep3Store.getState();
    const step4State = useStep4Store.getState();
    const sequence = buildStep4Sequence(step3State, step4State, 1.5, '/video.mp4'); // 1.5x 语速

    mockGenerateTTS.mockResolvedValue('/cache/fast.wav');
    await strategy.performTask(sequence[0].params, { bus: new Map() } as any, '/cache', vi.fn());

    // ✅ speechRate=1.5 应原样传递
    expect(mockGenerateTTS).toHaveBeenCalledWith('语速测试', 'edge', '/cache', 'zh-CN-XiaoxiaoNeural', 1.5);
  });

  it('案例6：step3 breakLongParagraphs 切分后子句共享 shotId，step4 应为每段子句生成独立音频且可区分', async () => {
    // 复现真实场景：step3 将一个长句切分为 2 个子句，共享 shotId='shot_A'，但 id 不同
    // step4 必须为每个子句独立合成，且返回结果能被前端按 id 区分（不能按 shotId 匹配）
    const step3Paragraphs = [
      { id: 'shot_A_sub_1', type: 'narration' as const, startMs: 0, durationMs: 1500, text: '死死盯住冰鱼！', shotId: 'shot_A', duration: 1.5, editing: false },
      { id: 'shot_A_sub_2', type: 'narration' as const, startMs: 1500, durationMs: 1800, text: '眼神杀气顿显！', shotId: 'shot_A', duration: 1.8, editing: false },
    ];
    useStep3Store.getState().setScriptParagraphs(step3Paragraphs);
    useStep4Store.setState({ ttsEngine: 'edge', ttsVoiceId: 'zh-CN-XiaoxiaoNeural' });

    const step3State = useStep3Store.getState();
    const step4State = useStep4Store.getState();
    const sequence = buildStep4Sequence(step3State, step4State, 1.0, '/video.mp4');

    // 模拟两段合成返回不同音频路径
    mockGenerateTTS
      .mockResolvedValueOnce('/cache/tts_sub_1.wav')
      .mockResolvedValueOnce('/cache/tts_sub_2.wav');

    const result = await strategy.performTask(
      sequence[0].params,
      { bus: new Map() } as any,
      '/cache',
      vi.fn(),
    );

    // ✅ 断言1：两段子句都被合成（不会因 shotId 相同而合并）
    expect(result.successCount).toBe(2);
    expect(mockGenerateTTS).toHaveBeenCalledTimes(2);

    // ✅ 断言2：两段返回的音频路径不同
    expect(result.shots[0].audioPath).toBe('/cache/tts_sub_1.wav');
    expect(result.shots[1].audioPath).toBe('/cache/tts_sub_2.wav');

    // ✅ 断言3：两段的 text 不同（对应不同子句文案）
    expect(result.shots[0].text).toBe('死死盯住冰鱼！');
    expect(result.shots[1].text).toBe('眼神杀气顿显！');

    // ✅ 断言4：两段的 shotId 不同（用 id 而非 shotId，避免子句共享 shotId 导致试听匹配错误）
    expect(result.shots[0].shotId).toBe('shot_A_sub_1');
    expect(result.shots[1].shotId).toBe('shot_A_sub_2');
  });

  // ============================================================
  // 案例7：TTS 服务不可用时合成失败，mapPipelineResultToState 应正确处理失败结果
  // 复现用户反馈：「合成文案音频后面点播放，每次只播放试听音色声音测试文案」
  // 场景A：所有段都失败 → ttsResults 应被覆盖为失败标记（audioUrl 为空），不再保留旧音频
  // 场景B：scriptShots 为空时返回 _failed → 走 else if 分支清空
  // ============================================================
  it('案例7：TTS 合成失败时，应清空旧 ttsResults 避免播放旧音频', async () => {
    // 1. 模拟 step3 有3段正常剧本
    useStep3Store.getState().setScriptParagraphs([
      { id: 'p1', type: 'narration', startMs: 0, durationMs: 1500, text: '死死盯住冰鱼！', shotId: 's1', duration: 1.5, editing: false },
      { id: 'p2', type: 'narration', startMs: 1500, durationMs: 1800, text: '眼神杀气顿显！', shotId: 's2', duration: 1.8, editing: false },
      { id: 'p3', type: 'narration', startMs: 3300, durationMs: 2500, text: '这把刀，他早就握紧了。', shotId: 's3', duration: 2.5, editing: false },
    ]);
    useStep4Store.setState({ ttsEngine: 'edge', ttsVoiceId: 'zh-CN-XiaoxiaoNeural' });

    // 2. 模拟 hydrate 加载的旧 ttsResults（上次试听保存的旧音频）
    const staleTtsResults = [
      { id: 'p1', shotId: 'p1', audioUrl: 'magic://local/old/tts_edge_stale_1.wav', duration: 3, _failed: false, _error: '' },
      { id: 'p2', shotId: 'p2', audioUrl: 'magic://local/old/tts_edge_stale_2.wav', duration: 3, _failed: false, _error: '' },
    ];
    useStep4Store.setState({ ttsResults: staleTtsResults });

    // 3. 模拟 TTS 服务不可用：generateTTS 全部 reject（ECONNREFUSED）
    mockGenerateTTS.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));

    const step3State = useStep3Store.getState();
    const step4State = useStep4Store.getState();
    const sequence = buildStep4Sequence(step3State, step4State, 1.0, '/video.mp4');

    // 4. 执行合成（Strategy 是 isRecoverable=true，部分失败时返回逐段结果）
    const result = await strategy.performTask(
      sequence[0].params,
      { bus: new Map() } as any,
      '/cache',
      vi.fn(),
    );

    // 5. 断言：合成全部失败，每段 shot 含 _failed 标记，audioPath 为 null
    expect(result.successCount).toBe(0);
    expect(result.failCount).toBe(3);
    expect(result.shots).toHaveLength(3);
    expect(result.shots.every((s: any) => s._failed === true)).toBe(true);
    expect(result.shots.every((s: any) => s.audioPath === null)).toBe(true);

    // 6. 关键断言：模拟 mapPipelineResultToState 处理失败结果
    const { mapPipelineResultToState } = await import('../../../../modules/editor/shell/frontend/hooks/usePipelineResultMapper');

    let setTtsResultsCallCount = 0;
    let lastSetTtsResultsArg: any = null;
    const mappers = {
      setAudioSeparated: vi.fn(),
      setAsrLines: vi.fn(),
      setFrameCount: vi.fn(),
      setExtractedData: vi.fn(),
      setVlmFrames: vi.fn(),
      setScriptParagraphs: vi.fn(),
      setTtsResults: (results: any[]) => {
        setTtsResultsCallCount++;
        lastSetTtsResultsArg = results;
      },
      setTtsProgress: vi.fn(),
      setMatchResults: vi.fn(),
      setVideoChunks: vi.fn(),
      setBeatTimestamps: vi.fn(),
    };

    // 7. 模拟 PipelineEngine 返回的 result 对象
    const pipelineResult = { 'tts-1': result };
    mapPipelineResultToState(pipelineResult, mappers as any);

    // 8. ✅ 核心断言1：setTtsResults 应被调用（覆盖旧数据）
    expect(setTtsResultsCallCount).toBe(1);

    // 9. ✅ 核心断言2：ttsResults 应为3段失败结果（audioUrl 为空），不再保留旧音频
    expect(lastSetTtsResultsArg).toHaveLength(3);
    expect(lastSetTtsResultsArg.every((r: any) => r._failed === true)).toBe(true);
    expect(lastSetTtsResultsArg.every((r: any) => !r.audioUrl)).toBe(true); // audioUrl 为空

    // 10. ✅ 核心断言3：不再是旧数据（旧数据 _failed=false 且有 audioUrl）
    expect(lastSetTtsResultsArg).not.toEqual(staleTtsResults);
  });

  // ============================================================
  // 案例7b：scriptShots 为空时返回 _failed，mapPipelineResultToState 应无条件覆盖清空
  // 覆盖 Strategy.ts:119-122 的「未找到前置剧本」降级路径
  // 注：usePipelineResultMapper 已移除 if(length>0) 守卫，ttsShots 为空时 map 得空数组，
  //     setTtsResults([]) 同样清空旧数据（与旧 else if 分支效果等价，但路径更直接）
  // ============================================================
  it('案例7b：scriptShots 为空返回 _failed 时，mapPipelineResultToState 应清空 ttsResults', async () => {
    // 1. step3 无剧本，step4 有旧数据
    useStep3Store.getState().setScriptParagraphs([]);
    useStep4Store.setState({
      ttsEngine: 'edge',
      ttsVoiceId: 'zh-CN-XiaoxiaoNeural',
      ttsResults: [{ id: 'old', shotId: 'old', audioUrl: 'magic://local/old.wav', _failed: false, _error: '' }],
    });

    const result = await strategy.performTask(
      { ttsEngine: 'edge', voiceId: 'zh-CN-XiaoxiaoNeural' },
      { bus: new Map() } as any,
      '/cache',
      vi.fn(),
    );

    // 2. 断言：返回 _failed 降级结果（无 shots 字段）
    expect(result._failed).toBe(true);
    expect(result.shots).toBeUndefined();

    // 3. 模拟 mapPipelineResultToState 处理降级结果
    const { mapPipelineResultToState } = await import('../../../../modules/editor/shell/frontend/hooks/usePipelineResultMapper');

    let lastSetTtsResultsArg: any = 'NOT_CALLED';
    const mappers = {
      setAudioSeparated: vi.fn(),
      setAsrLines: vi.fn(),
      setFrameCount: vi.fn(),
      setExtractedData: vi.fn(),
      setVlmFrames: vi.fn(),
      setScriptParagraphs: vi.fn(),
      setTtsResults: (results: any[]) => { lastSetTtsResultsArg = results; },
      setTtsProgress: vi.fn(),
      setMatchResults: vi.fn(),
      setVideoChunks: vi.fn(),
      setBeatTimestamps: vi.fn(),
    };

    mapPipelineResultToState({ 'tts-1': result }, mappers as any);

    // 4. ✅ 关键断言：无条件 map 覆盖，ttsShots 为空得空数组，setTtsResults([]) 清空旧数据
    expect(lastSetTtsResultsArg).toEqual([]);
  });

  // ============================================================
  // 案例8：TTS 服务正常时合成成功，mapPipelineResultToState 应正确填充新 ttsResults
  // 对比案例7，确认成功路径不受影响
  // ============================================================
  it('案例8：TTS 合成成功时，应正确填充新 ttsResults（非空）', async () => {
    useStep3Store.getState().setScriptParagraphs([
      { id: 'p1', type: 'narration', startMs: 0, durationMs: 1500, text: '死死盯住冰鱼！', shotId: 's1', duration: 1.5, editing: false },
    ]);
    useStep4Store.setState({ ttsEngine: 'edge', ttsVoiceId: 'zh-CN-XiaoxiaoNeural' });

    // 模拟旧数据（应被新结果覆盖）
    useStep4Store.setState({
      ttsResults: [{ id: 'old', shotId: 'old', audioUrl: 'magic://local/old.wav', _failed: false, _error: '' }],
    });

    // 模拟合成成功
    mockGenerateTTS.mockResolvedValue('C:\\cache\\tts_edge_1234.wav');

    const step3State = useStep3Store.getState();
    const step4State = useStep4Store.getState();
    const sequence = buildStep4Sequence(step3State, step4State, 1.0, '/video.mp4');

    const result = await strategy.performTask(
      sequence[0].params,
      { bus: new Map() } as any,
      '/cache',
      vi.fn(),
    );

    // 断言合成成功
    expect(result._failed).toBeUndefined();
    expect(result.successCount).toBe(1);
    expect(result.shots).toHaveLength(1);
    expect(result.shots[0].audioPath).toBe('C:\\cache\\tts_edge_1234.wav');

    // 模拟 mapPipelineResultToState 处理成功结果
    const { mapPipelineResultToState } = await import('../../../../modules/editor/shell/frontend/hooks/usePipelineResultMapper');

    let lastSetTtsResultsArg: any = null;
    const mappers = {
      setAudioSeparated: vi.fn(),
      setAsrLines: vi.fn(),
      setFrameCount: vi.fn(),
      setExtractedData: vi.fn(),
      setVlmFrames: vi.fn(),
      setScriptParagraphs: vi.fn(),
      setTtsResults: (results: any[]) => { lastSetTtsResultsArg = results; },
      setTtsProgress: vi.fn(),
      setMatchResults: vi.fn(),
      setVideoChunks: vi.fn(),
      setBeatTimestamps: vi.fn(),
    };

    mapPipelineResultToState({ 'tts-1': result }, mappers as any);

    // ✅ 成功路径：ttsResults 应被填充为新结果（1段），且 audioUrl 转为 magic:// 格式
    expect(lastSetTtsResultsArg).toHaveLength(1);
    expect(lastSetTtsResultsArg[0].audioUrl).toBe('magic://local/C:/cache/tts_edge_1234.wav');
    expect(lastSetTtsResultsArg[0].shotId).toBe('p1');
    expect(lastSetTtsResultsArg[0]._failed).toBe(false);
  });
});
