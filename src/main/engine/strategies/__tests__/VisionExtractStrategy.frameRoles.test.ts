// 📁 路径: src/main/engine/strategies/__tests__/VisionExtractStrategy.frameRoles.test.ts
// 🎭 P0.5 帧级角色锚定单元测试
// 重点验证：
//   1. deriveFrameRolesFromFaces — 从 roles[].faces[].frame_index 自动推导 frameRoles
//   2. buildFrameRolesAnchoringPrompt — 构建逐帧角色锚定 prompt 段

import { describe, it, expect, vi } from 'vitest';

// === Mock 依赖链 ===
// VisionExtractStrategy 导入链中 VisionProcessor → ProcessManager → app.on('before-quit')
// 在 Node.js 测试环境中 app 不存在，必须 mock 掉这些模块避免顶层副作用

/** Mock ProcessManager — 避免 Electron app.on 副作用 */
vi.mock('../../../utils/processManager', () => ({
  ProcessManager: {
    spawnSafe: vi.fn(),
    killAll: vi.fn(),
  },
}));

/** Mock VisionProcessor — 避免导入 processManager 和 PythonClient */
vi.mock('../../media/VisionProcessor', () => ({
  VisionProcessor: {
    extractKeyframes: vi.fn(),
    scanFaces: vi.fn(),
    clusterFaces: vi.fn(),
    extractSemantics: vi.fn(),
    generateSemanticFlow: vi.fn(),
  },
}));

/** Mock PerceptualHasher */
vi.mock('../../media/PerceptualHasher', () => ({
  PerceptualHasher: {
    batchComputePHash: vi.fn(() => []),
    batchComputeContentHash: vi.fn(() => new Map()),
    isStaticShot: vi.fn(() => false),
  },
}));

/** Mock VlmFrameCacheRepository */
vi.mock('../../../database/repositories/VlmFrameCacheRepository', () => ({
  VlmFrameCacheRepository: class {
    batchGet() { return new Map(); }
  },
}));

/** Mock ContactSheetBuilder */
vi.mock('../../media/ContactSheetBuilder', () => ({
  ContactSheetBuilder: {
    build: vi.fn(),
    autoSelectLayout: vi.fn(() => '2x2' as const),
    getCellCount: vi.fn(() => 4),
  },
}));

/** Mock LLMFactory */
vi.mock('../../adapters/LLMFactory', () => ({
  LLMFactory: {
    createAdapter: vi.fn(() => ({
      adapter: { chat: vi.fn() },
      modelName: 'qwen-test',
      temperature: 0.7,
    })),
  },
}));

/** Mock AppLogger */
vi.mock('../../../core/AppLogger', () => ({
  AppLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

/** Mock LogConstants */
vi.mock('@modules/infra/logger/LogConstants', () => ({
  LOG_TAGS: { AI_AGENT: 'AI_AGENT', SCHEDULER: 'SCHEDULER', MEDIA_ENGINE: 'MEDIA_ENGINE' },
}));

/** Mock PromptBuilder */
vi.mock('../prompts/PromptBuilder', () => ({
  PromptBuilder: {
    buildVisionExtractPrompt: vi.fn(() => ({
      systemPrompt: 'mock-system-prompt',
      userPrompt: 'mock-user-prompt',
    })),
  },
}));

import {
  deriveFrameRolesFromFaces,
  buildFrameRolesAnchoringPrompt,
} from '../VisionExtractStrategy';

describe('🎭 P0.5 deriveFrameRolesFromFaces — 自动推导 frameRoles', () => {
  /** 基础场景：3 个角色，face 帧 @1fps，VLM 帧间隔 4s */
  it('应正确将 face frame_index（1fps）映射到 VLM 帧索引（estimatedInterval=4s）', () => {
    const roles = [
      {
        id: 'r1',
        name: '张三',
        faces: [
          { frame_index: 0 },   // 第 0 秒 → VLM 第 0 帧 (0/4=0)
          { frame_index: 5 },   // 第 5 秒 → VLM 第 1 帧 (5/4=1)
          { frame_index: 10 },  // 第 10 秒 → VLM 第 2 帧 (10/4=2)
        ],
      },
      {
        id: 'r2',
        name: '李四',
        faces: [
          { frame_index: 4 },   // 第 4 秒 → VLM 第 1 帧 (4/4=1)
          { frame_index: 12 },  // 第 12 秒 → VLM 第 3 帧 (12/4=3)
        ],
      },
    ];

    const result = deriveFrameRolesFromFaces(roles, 5, 4);
    expect(result).not.toBeNull();
    expect(result![0]).toEqual(['张三']);
    expect(result![1]).toEqual(['张三', '李四']);
    expect(result![2]).toEqual(['张三']);
    expect(result![3]).toEqual(['李四']);
    expect(result![4]).toBeUndefined(); // 第 4 帧无人
  });

  /** 多人物同帧去重 */
  it('同一 VLM 帧上同一人物的多个 face 应去重', () => {
    const roles = [
      {
        id: 'r1',
        name: '张三',
        faces: [
          { frame_index: 0 },
          { frame_index: 1 },
          { frame_index: 2 },
          { frame_index: 3 },
        ],
      },
    ];

    // 4 个 face 都落在 VLM 第 0 帧（0,1,2,3 秒 / 4s = 0）
    const result = deriveFrameRolesFromFaces(roles, 3, 4);
    expect(result).not.toBeNull();
    expect(result![0]).toEqual(['张三']); // 去重后只剩一个
    expect(result![1]).toBeUndefined();
  });

  /** frame_index 超出 VLM 帧范围 → 截断到最后一帧 */
  it('face frame_index 超出 VLM 帧范围时应截断到最后一帧', () => {
    const roles = [
      {
        id: 'r1',
        name: '张三',
        faces: [{ frame_index: 100 }], // 第 100 秒，但 VLM 只有 3 帧
      },
    ];

    const result = deriveFrameRolesFromFaces(roles, 3, 4);
    expect(result).not.toBeNull();
    expect(result![2]).toEqual(['张三']); // 截断到第 2 帧（最后一帧）
  });

  /** 无效输入：roles 为空 */
  it('roles 为空时返回 null', () => {
    expect(deriveFrameRolesFromFaces([], 10, 4)).toBeNull();
  });

  /** 无效输入：totalFrameCount <= 0 */
  it('totalFrameCount <= 0 时返回 null', () => {
    const roles = [{ id: 'r1', name: '张三', faces: [{ frame_index: 0 }] }];
    expect(deriveFrameRolesFromFaces(roles, 0, 4)).toBeNull();
  });

  /** 无效输入：estimatedInterval <= 0 */
  it('estimatedInterval <= 0 时返回 null', () => {
    const roles = [{ id: 'r1', name: '张三', faces: [{ frame_index: 0 }] }];
    expect(deriveFrameRolesFromFaces(roles, 10, 0)).toBeNull();
    expect(deriveFrameRolesFromFaces(roles, 10, -1)).toBeNull();
    expect(deriveFrameRolesFromFaces(roles, 10, NaN)).toBeNull();
    expect(deriveFrameRolesFromFaces(roles, 10, Infinity)).toBeNull();
  });

  /** 无效输入：roles 无 faces 或 faces 为空 */
  it('roles 无 faces 或 faces 为空时返回 null', () => {
    const roles = [
      { id: 'r1', name: '张三', faces: [] },
      { id: 'r2', name: '李四' },
    ];
    expect(deriveFrameRolesFromFaces(roles as any, 10, 4)).toBeNull();
  });

  /** face.frame_index 缺失或非数字 → 跳过该 face */
  it('face.frame_index 缺失或非数字时应跳过', () => {
    const roles = [
      {
        id: 'r1',
        name: '张三',
        faces: [
          { frame_index: 'abc' } as any, // 非数字 → 跳过
          { no_index: true } as any,      // 缺失 → 跳过
          { frame_index: null } as any,   // null → 跳过
          { frame_index: 4 },             // 有效 → VLM 第 1 帧
        ],
      },
    ];

    const result = deriveFrameRolesFromFaces(roles, 3, 4);
    expect(result).not.toBeNull();
    expect(result![1]).toEqual(['张三']);
  });

  /** 兼容 frameIndex 驼峰命名 */
  it('应兼容 face.frameIndex（驼峰）字段名', () => {
    const roles = [
      {
        id: 'r1',
        name: '张三',
        faces: [{ frameIndex: 8 } as any], // 驼峰命名
      },
    ];

    const result = deriveFrameRolesFromFaces(roles, 5, 4);
    expect(result).not.toBeNull();
    expect(result![2]).toEqual(['张三']); // 8/4=2
  });

  /** 多角色混合：不同角色落在同一 VLM 帧 */
  it('多个不同角色落在同一 VLM 帧时应合并为列表', () => {
    const roles = [
      { id: 'r1', name: '张三', faces: [{ frame_index: 4 }] },
      { id: 'r2', name: '李四', faces: [{ frame_index: 5 }] },
      { id: 'r3', name: '王五', faces: [{ frame_index: 6 }] },
    ];
    // 4,5,6 秒都落在 VLM 第 1 帧 (4/4=1, 5/4=1, 6/4=1)

    const result = deriveFrameRolesFromFaces(roles, 5, 4);
    expect(result).not.toBeNull();
    expect(result![1]).toEqual(['张三', '李四', '王五']);
  });
});

describe('🎭 P0.5 buildFrameRolesAnchoringPrompt — 构建锚定 prompt', () => {
  /** 正常场景：部分帧有角色 */
  it('应为有角色的帧生成锚定段，无角色的帧标注"未检测到人物"', () => {
    const batchFrames = [
      { idx: 0, path: '/frame_0.jpg' },
      { idx: 1, path: '/frame_1.jpg' },
      { idx: 2, path: '/frame_2.jpg' },
    ];
    const frameRoles = {
      0: ['张三'],
      1: ['张三', '李四'],
      // 第 2 帧无人
    };

    const prompt = buildFrameRolesAnchoringPrompt(batchFrames, frameRoles);
    expect(prompt).toContain('【逐帧角色锚定】');
    expect(prompt).toContain('第1张（第0帧）：张三');
    expect(prompt).toContain('第2张（第1帧）：张三、李四');
    expect(prompt).toContain('第3张（第2帧）：未检测到人物');
    expect(prompt).toContain('严禁使用"男子/女子/青年"等模糊代称');
  });

  /** frameRoles 为 undefined → 返回空字符串 */
  it('frameRoles 为 undefined 时返回空字符串', () => {
    const batchFrames = [{ idx: 0, path: '/frame_0.jpg' }];
    expect(buildFrameRolesAnchoringPrompt(batchFrames, undefined)).toBe('');
  });

  /** 所有帧都"未检测到人物" → 返回空字符串（避免无谓 prompt 膨胀） */
  it('所有帧都无角色时返回空字符串', () => {
    const batchFrames = [
      { idx: 0, path: '/frame_0.jpg' },
      { idx: 1, path: '/frame_1.jpg' },
    ];
    const frameRoles = {}; // 空对象，所有帧都未检测到

    expect(buildFrameRolesAnchoringPrompt(batchFrames, frameRoles)).toBe('');
  });

  /** 空数组帧列表 → 返回空字符串 */
  it('空帧列表时返回空字符串', () => {
    const frameRoles = { 0: ['张三'] };
    expect(buildFrameRolesAnchoringPrompt([], frameRoles)).toBe('');
  });

  /** 批次内帧索引与 frameRoles 键不匹配 → 标注"未检测到人物" */
  it('frameRoles 中无对应帧索引时标注"未检测到人物"', () => {
    const batchFrames = [
      { idx: 5, path: '/frame_5.jpg' },
      { idx: 10, path: '/frame_10.jpg' },
    ];
    const frameRoles = {
      10: ['王五'],
      // idx=5 无对应键
    };

    const prompt = buildFrameRolesAnchoringPrompt(batchFrames, frameRoles);
    expect(prompt).toContain('第1张（第5帧）：未检测到人物');
    expect(prompt).toContain('第2张（第10帧）：王五');
  });
});
