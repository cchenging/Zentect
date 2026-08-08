// 📁 路径: src/modules/editor/stores/__tests__/hydrateProjectData.vlmFrames.test.ts
// hydrateProjectData 中 vlmFrames 恢复行为测试
// 验证修复后：partial hydration（不传 vlmFrames）不再清空 store 中已恢复的数据
// 覆盖：完整 hydrate 恢复、partial hydrate 不清空、step3/4/5 同类字段保护

import { describe, it, expect, vi, beforeEach } from 'vitest';

// === Mock 依赖 ===

/** Mock AppNotifier — 避免测试中触发真实通知 */
vi.mock('@renderer/core/AppNotifier', () => ({
  AppNotifier: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

/** Mock API — 避免测试中触发真实 IPC 调用 */
vi.mock('@renderer/api', () => ({
  API: {
    project: { saveData: vi.fn(), loadData: vi.fn() },
    engine: { runPipeline: vi.fn(), abortPipeline: vi.fn() },
    media: { update: vi.fn() },
    events: {
      onExtractionSuccess: vi.fn(),
      offExtractionSuccess: vi.fn(),
    },
  },
}));

import { useProjectStore } from '../useProjectStore';
import { useStep1Store } from '@modules/pipeline/stores/useStep1Store';
import { useStep2Store } from '@modules/pipeline/stores/useStep2Store';
import { useStep3Store } from '@modules/pipeline/stores/useStep3Store';
import { useStep4Store } from '@modules/pipeline/stores/useStep4Store';
import { useStep5Store } from '@modules/pipeline/stores/useStep5Store';
import { usePipelineStore } from '@renderer/store/usePipelineStore';

/**
 * 构造标准 vlmFrames 测试数据
 */
function buildTestVlmFrames(): any[] {
  return [
    {
      url: 'magic://proj_test/frame1.jpg',
      description: '男子走入画面，暖色调室内场景',
      editing: false,
      confirmed: true,
    },
    {
      url: 'magic://proj_test/frame2.jpg',
      description: '男子拿起杯子，近景特写',
      editing: false,
      confirmed: true,
    },
    {
      url: 'magic://proj_test/frame3.jpg',
      description: '男子微笑饮茶，面部特写',
      editing: false,
      confirmed: true,
    },
  ];
}

describe('hydrateProjectData - vlmFrames 恢复行为', () => {
  beforeEach(() => {
    // 重置所有 store 到初始状态
    useProjectStore.getState().resetProjectState();
    useStep1Store.getState().setAsrLines([]);
    useStep1Store.getState().setFrameCount(0);
    useStep2Store.getState().setVlmFrames([]);
    useStep3Store.getState().setScriptParagraphs([]);
    useStep4Store.getState().setTtsResults([]);
    useStep5Store.getState().setVideoChunks([]);
    // 重置 subStepStatuses 为 idle
    const subKeys = ['frames', 'audio', 'whisper', 'faces'];
    for (const k of subKeys) {
      usePipelineStore.getState().setSubStepStatus(k, 'idle');
    }
    vi.clearAllMocks();
  });

  // ══════════════════════════════════════════
  // 场景1：完整 hydrate 正确恢复 vlmFrames
  // ══════════════════════════════════════════

  it('完整 hydrate（含 vlmFrames）→ store 中 vlmFrames 被正确设置', () => {
    const frames = buildTestVlmFrames();

    useProjectStore.getState().hydrateProjectData({
      id: 'test_proj_001',
      name: '测试项目',
      mediaItems: [],
      roles: [],
      shots: [],
      aiShots: [],
      vlmFrames: frames,
    });

    const s2 = useStep2Store.getState();
    expect(s2.vlmFrames).toHaveLength(3);
    expect(s2.vlmFrames[0].description).toContain('男子走入画面');
    expect(s2.vlmFrames[2].description).toContain('男子微笑饮茶');
  });

  // ══════════════════════════════════════════
  // 场景2：partial merge（无 vlmFrames）不清空已有数据 ★核心修复验证
  // 🛑 原则 2：partial 增量走 mergePartialUpdate,不进 hydrate
  // ══════════════════════════════════════════

  it('partial merge（无 vlmFrames）→ store 中 vlmFrames 保持不变（修复后行为）', () => {
    // 步骤1：先通过完整 hydrate 设置 vlmFrames（模拟从 DB 恢复）
    useProjectStore.getState().hydrateProjectData({
      id: 'test_proj_001',
      name: '测试项目',
      mediaItems: [],
      roles: [],
      shots: [],
      aiShots: [],
      vlmFrames: buildTestVlmFrames(),
    });
    expect(useStep2Store.getState().vlmFrames).toHaveLength(3);

    // 步骤2：模拟 IPCBridge 的 partial merge（只传 shots/roles，不传 vlmFrames）
    // 🛑 原则 2：partial 走 mergePartialUpdate,不会清空其他字段
    useProjectStore.getState().mergePartialUpdate({
      shots: [],
      aiShots: [],
      roles: [],
      audioSeparated: true,
      mediaItems: [],
      // ❌ 不传 vlmFrames — mergePartialUpdate 不影响未传字段
    });

    // ✅ vlmFrames 应保持 3 帧，不被清空
    const s2 = useStep2Store.getState();
    expect(s2.vlmFrames).toHaveLength(3);
    expect(s2.vlmFrames[0].description).toContain('男子走入画面');
  });

  // ══════════════════════════════════════════
  // 场景3：hydrate 无条件清空(新项目场景)
  // ══════════════════════════════════════════

  it('hydrate 传 vlmFrames=[] → store 中 vlmFrames 被清空（新项目场景）', () => {
    // 先设置 vlmFrames
    useProjectStore.getState().hydrateProjectData({
      id: 'test_proj_001',
      name: '测试项目',
      mediaItems: [],
      roles: [],
      shots: [],
      aiShots: [],
      vlmFrames: buildTestVlmFrames(),
    });
    expect(useStep2Store.getState().vlmFrames).toHaveLength(3);

    // 新项目 hydrate(空就是空,无条件设置)
    useProjectStore.getState().hydrateProjectData({
      id: 'test_proj_002',
      name: '新项目',
      mediaItems: [],
      roles: [],
      shots: [],
      aiShots: [],
      vlmFrames: [],
    });

    // 新项目无 vlmFrames
    expect(useStep2Store.getState().vlmFrames).toHaveLength(0);
  });

  // ════════════════════════════════════════════════════════════════
  // 场景4-6：step3/4/5 同类数组字段在 partial merge 中保持不变
  // ════════════════════════════════════════════════════════════════

  it('partial merge（无 scriptParagraphs）→ step3 store 保持不变', () => {
    // 先设置 scriptParagraphs
    useProjectStore.getState().hydrateProjectData({
      id: 'test_proj_001',
      name: '测试项目',
      mediaItems: [],
      roles: [],
      shots: [],
      aiShots: [],
      scriptParagraphs: [{ id: 'p1', text: '解说段落1' }],
    });
    expect(useStep3Store.getState().scriptParagraphs).toHaveLength(1);

    // partial merge 不传 scriptParagraphs
    useProjectStore.getState().mergePartialUpdate({
      shots: [],
      roles: [],
    });

    // mergePartialUpdate 不影响未传字段
    expect(useStep3Store.getState().scriptParagraphs).toHaveLength(1);
    expect(useStep3Store.getState().scriptParagraphs[0].text).toBe('解说段落1');
  });

  it('partial merge（无 ttsResults）→ step4 store 保持不变', () => {
    useProjectStore.getState().hydrateProjectData({
      id: 'test_proj_001',
      name: '测试项目',
      mediaItems: [],
      roles: [],
      shots: [],
      aiShots: [],
      ttsResults: [{ shotId: 's1', audioUrl: 'magic://local/audio1.wav' }],
    });
    expect(useStep4Store.getState().ttsResults).toHaveLength(1);

    // partial merge 不传 ttsResults
    useProjectStore.getState().mergePartialUpdate({
      shots: [],
      roles: [],
    });

    expect(useStep4Store.getState().ttsResults).toHaveLength(1);
  });

  it('partial merge（无 videoChunks）→ step5 store 保持不变', () => {
    useProjectStore.getState().hydrateProjectData({
      id: 'test_proj_001',
      name: '测试项目',
      mediaItems: [],
      roles: [],
      shots: [],
      aiShots: [],
      videoChunks: [{ id: 'vc1' }],
    });
    expect(useStep5Store.getState().videoChunks).toHaveLength(1);

    // partial merge 不传 videoChunks
    useProjectStore.getState().mergePartialUpdate({
      shots: [],
      roles: [],
    });

    expect(useStep5Store.getState().videoChunks).toHaveLength(1);
  });

  // ══════════════════════════════════════════
  // 场景7：完整端到端模拟 — step2 完成 → IPCBridge partial merge → vlmFrames 不丢
  // ══════════════════════════════════════════

  it('端到端：step2 完成保存 → IPCBridge partial merge → vlmFrames 不丢失', () => {
    // ─── 阶段1：模拟项目进场，从 DB 恢复 vlmFrames ───
    useProjectStore.getState().hydrateProjectData({
      id: 'test_proj_001',
      name: '测试项目',
      mediaItems: [{ id: 'm1', type: 'video', filePath: '/test.mp4' }],
      roles: [],
      shots: [],
      aiShots: [],
      vlmFrames: buildTestVlmFrames(),
      stepStatuses: ['completed', 'completed', 'idle', 'idle', 'idle'],
      stepCompleted: [true, true, false, false, false],
    });
    expect(useStep2Store.getState().vlmFrames).toHaveLength(3);

    // ─── 阶段2：模拟 IPCBridge 收到 NOTIFY_PIPELINE_EVENT 后的 partial merge ───
    // 🛑 原则 2：IPCBridge 现已改用 mergePartialUpdate
    useProjectStore.getState().mergePartialUpdate({
      shots: [],
      aiShots: [],
      roles: [],
      audioSeparated: true,
      mediaItems: [{ id: 'm1', type: 'video', filePath: '/test.mp4' }],
      // ❌ 不传 vlmFrames — mergePartialUpdate 不会清空
    });

    // ─── 验证：vlmFrames 仍在 store 中 ───
    const s2 = useStep2Store.getState();
    expect(s2.vlmFrames).toHaveLength(3);
    expect(s2.vlmFrames[0].description).toContain('男子走入画面');
    expect(s2.vlmFrames[2].description).toContain('男子微笑饮茶');
  });

  // ══════════════════════════════════════════
  // 场景8：连续多次 partial merge 不累积清空
  // ══════════════════════════════════════════

  it('连续多次 partial merge → vlmFrames 始终保持不变', () => {
    // 初始完整 hydrate
    useProjectStore.getState().hydrateProjectData({
      id: 'test_proj_001',
      name: '测试项目',
      mediaItems: [],
      roles: [],
      shots: [],
      aiShots: [],
      vlmFrames: buildTestVlmFrames(),
    });

    // 连续 3 次 partial merge（模拟多次 IPC 事件）
    for (let i = 0; i < 3; i++) {
      useProjectStore.getState().mergePartialUpdate({
        shots: [],
        roles: [],
        mediaItems: [],
      });
    }

    // vlmFrames 应始终为 3 帧
    expect(useStep2Store.getState().vlmFrames).toHaveLength(3);
  });

  // ══════════════════════════════════════════
  // 场景9：★新项目 hydrate 不泄漏旧项目数据(P0 bug 回归测试)
  // ══════════════════════════════════════════

  it('项目A hydrate → 项目B hydrate(空) → 项目B 无项目A 数据泄漏', () => {
    // ─── 阶段1：项目 A 完整 hydrate,有 ASR/帧数据 ───
    useProjectStore.getState().hydrateProjectData({
      id: 'proj_A',
      name: '项目A',
      mediaItems: [],
      roles: [],
      shots: [],
      aiShots: [],
      asrLines: [{ id: 'asr1', text: '项目A的台词' }],
      frameCount: 100,
      // 统一数据源：frameCount 以 framePaths 为真相源派生，故这里提供与 frameCount 一致的 100 条路径
      framePaths: Array.from({ length: 100 }, (_, i) => `/frame_A_${String(i + 1).padStart(3, '0')}.jpg`),
      vlmFrames: buildTestVlmFrames(),
      subStepStatuses: { frames: 'completed', audio: 'completed', whisper: 'completed', faces: 'completed' },
    });
    expect(useStep1Store.getState().asrLines).toHaveLength(1);
    expect(useStep1Store.getState().frameCount).toBe(100);
    expect(useStep2Store.getState().vlmFrames).toHaveLength(3);

    // ─── 阶段2：项目 B 完整 hydrate,DB 无数据(新项目) ───
    useProjectStore.getState().hydrateProjectData({
      id: 'proj_B',
      name: '项目B',
      mediaItems: [],
      roles: [],
      shots: [],
      aiShots: [],
      asrLines: [],
      frameCount: 0,
      framePaths: [],
      vlmFrames: [],
      subStepStatuses: {},
    });

    // ─── 验证：项目 B 无项目 A 数据泄漏 ───
    expect(useStep1Store.getState().asrLines).toHaveLength(0);
    expect(useStep1Store.getState().frameCount).toBe(0);
    expect(useStep2Store.getState().vlmFrames).toHaveLength(0);
    // subStepStatuses 应重置为 idle,不是保留项目 A 的 completed
    const subSteps = usePipelineStore.getState().subStepStatuses;
    expect(subSteps.frames).toBe('idle');
    expect(subSteps.audio).toBe('idle');
    expect(subSteps.whisper).toBe('idle');
    expect(subSteps.faces).toBe('idle');
  });
});
