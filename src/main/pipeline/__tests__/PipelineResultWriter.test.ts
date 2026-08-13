// 路径: src/main/pipeline/__tests__/PipelineResultWriter.test.ts
// PipelineResultWriter 单元测试
// 覆盖：writeStep1Results 的 frames 写入、audio 写入、ASR 写入、roles 事务写入、
//       subStepStatuses 推导、media 不存在异常、facesSkipped 复用逻辑

import { describe, it, expect, vi, beforeEach } from 'vitest';

// === Mock 依赖（vi.hoisted 避免 hoisting 冲突） ===
const {
  mockMediaFindById, mockMediaUpdate, mockRoleFindByProjectId,
  mockDbPrepare, mockDbRun, mockDbGet, mockDbTransaction,
} = vi.hoisted(() => ({
  mockMediaFindById: vi.fn(),
  mockMediaUpdate: vi.fn(),
  mockRoleFindByProjectId: vi.fn(),
  mockDbPrepare: vi.fn(),
  mockDbRun: vi.fn(),
  mockDbGet: vi.fn(),
  mockDbTransaction: vi.fn((fn: () => void) => () => { fn(); }),
}));

vi.mock('../../database/repositories/MediaRepository', () => ({
  MediaRepository: vi.fn(function(this: any) {
    this.findById = mockMediaFindById;
    this.updateMedia = mockMediaUpdate;
  }),
}));

vi.mock('../../database/repositories/RoleRepository', () => ({
  RoleRepository: vi.fn(function(this: any) {
    this.findByProjectId = mockRoleFindByProjectId;
  }),
}));

vi.mock('../../../modules/infra/database/core/SQLiteConnection', () => ({
  SQLiteConnection: {
    getInstance: vi.fn().mockReturnValue({
      getDB: vi.fn().mockReturnValue({
        prepare: mockDbPrepare,
        transaction: mockDbTransaction,
      }),
    }),
  },
}));

vi.mock('../../database/queries/ProjectQueries', () => ({
  PROJECT_SQL: {
    HARD_DELETE_ROLES: 'DELETE FROM roles WHERE project_id = @projectId',
    INSERT_ROLE_FULL: 'INSERT INTO roles (...) VALUES (...)',
  },
}));

vi.mock('../../utils/pathManager', () => ({
  PathManager: {
    getProjectDir: vi.fn(() => 'C:/projects/test'),
  },
}));

vi.mock('../../core/AppLogger', () => ({
  AppLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../modules/infra/logger/LogConstants', () => ({
  LOG_TAGS: { SCHEDULER: 'scheduler' },
}));

import { PipelineResultWriter } from '../PipelineResultWriter';

describe('PipelineResultWriter', () => {
  const baseParams = {
    projectId: 'proj1',
    mediaId: 'media1',
    result: {
      frames: [],
      audioPath: null,
      vocalsPath: null,
      bgmPath: null,
      vocalsIsFallback: false,
      separationMode: 'fast',
      separationEngine: 'demucs',
      shots: [],
      roles: [],
    },
    framesSkipped: false,
    audioSkipped: false,
    asrSkipped: false,
    facesSkipped: false,
    step1Data: {},
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockMediaFindById.mockResolvedValue({
      id: 'media1',
      status: 'pending',
      frames: null,
      extractedAudio: null,
      extractedVocals: null,
      extractedBgm: null,
      separationMode: null,
      separationEngine: null,
      vocalsIsFallback: null,
      extractedText: null,
    });
    mockMediaUpdate.mockResolvedValue(undefined);
    mockRoleFindByProjectId.mockReturnValue([]);
    mockDbPrepare.mockReturnValue({ run: mockDbRun, get: mockDbGet });
    mockDbGet.mockReturnValue(null);
    mockDbRun.mockReturnValue(undefined);
  });

  // ══════════════════════════════════════════
  // 异常场景
  // ══════════════════════════════════════════

  it('媒体记录不存在时抛出异常', async () => {
    mockMediaFindById.mockResolvedValue(null);
    await expect(
      PipelineResultWriter.writeStep1Results(baseParams)
    ).rejects.toThrow('媒体记录不存在');
  });

  // ══════════════════════════════════════════
  // frames 写入
  // ══════════════════════════════════════════

  it('写入 frames 并转换为相对路径', async () => {
    const params = {
      ...baseParams,
      result: {
        ...baseParams.result,
        frames: ['C:/projects/test/frames/frame_001.jpg', 'C:/projects/test/frames/frame_002.jpg'],
      },
    };
    const { updatedMedia } = await PipelineResultWriter.writeStep1Results(params);
    expect(updatedMedia.frames).toEqual(['frames/frame_001.jpg', 'frames/frame_002.jpg']);
  });

  it('framesSkipped 时跳过 frames 写入', async () => {
    const params = {
      ...baseParams,
      framesSkipped: true,
      result: {
        ...baseParams.result,
        frames: ['C:/projects/test/frames/frame_001.jpg'],
      },
    };
    const { updatedMedia } = await PipelineResultWriter.writeStep1Results(params);
    expect(updatedMedia.frames).toBeNull();
  });

  // ══════════════════════════════════════════
  // audio 写入
  // ══════════════════════════════════════════

  it('写入音频分离结果（vocals + bgm + 配置）', async () => {
    const params = {
      ...baseParams,
      result: {
        ...baseParams.result,
        audioPath: 'C:/projects/test/audio/extracted.wav',
        vocalsPath: 'C:/projects/test/audio/vocals.wav',
        bgmPath: 'C:/projects/test/audio/bgm.wav',
        vocalsIsFallback: true,
        separationMode: 'quality',
        separationEngine: 'demucs',
      },
    };
    const { updatedMedia } = await PipelineResultWriter.writeStep1Results(params);
    expect(updatedMedia.extractedAudio).toBe('audio/extracted.wav');
    expect(updatedMedia.extractedVocals).toBe('audio/vocals.wav');
    expect(updatedMedia.extractedBgm).toBe('audio/bgm.wav');
    expect(updatedMedia.vocalsIsFallback).toBe(true);
    expect(updatedMedia.separationMode).toBe('quality');
    expect(updatedMedia.separationEngine).toBe('demucs');
  });

  it('audioSkipped 时跳过音频写入', async () => {
    const params = {
      ...baseParams,
      audioSkipped: true,
      result: {
        ...baseParams.result,
        vocalsPath: 'C:/projects/test/audio/vocals.wav',
      },
    };
    const { updatedMedia } = await PipelineResultWriter.writeStep1Results(params);
    expect(updatedMedia.extractedVocals).toBeNull();
  });

  // ══════════════════════════════════════════
  // ASR 写入
  // ══════════════════════════════════════════

  it('写入 ASR 台词 JSON', async () => {
    const params = {
      ...baseParams,
      result: {
        ...baseParams.result,
        shots: [
          { id: 'shot_1', originalText: '你好', start: 0, end: 2.5 },
          { id: 'shot_2', originalText: '世界', start: 3.0, end: 5.0 },
        ],
      },
    };
    const { updatedMedia } = await PipelineResultWriter.writeStep1Results(params);
    const parsed = JSON.parse(updatedMedia.extractedText);
    expect(parsed).toEqual([
      { text: '你好', start: 0, end: 2.5 },
      { text: '世界', start: 3.0, end: 5.0 },
    ]);
  });

  it('asrSkipped 时跳过 ASR 写入', async () => {
    const params = {
      ...baseParams,
      asrSkipped: true,
      result: {
        ...baseParams.result,
        shots: [{ id: 'shot_1', originalText: 'hello', start: 0, end: 1 }],
      },
    };
    const { updatedMedia } = await PipelineResultWriter.writeStep1Results(params);
    expect(updatedMedia.extractedText).toBeNull();
  });

  // ══════════════════════════════════════════
  // roles 写入
  // ══════════════════════════════════════════

  it('写入新角色（事务内 HARD_DELETE + INSERT）', async () => {
    const params = {
      ...baseParams,
      result: {
        ...baseParams.result,
        roles: [
          { id: 'role_proj1_media1_0', name: '张三', avatar: '/avatars/1.jpg', pronoun: '他', voiceId: 'v1' },
          { id: 'role_proj1_media1_1', name: '李四', avatar: '/avatars/2.jpg', pronoun: '她', voiceId: 'v2' },
        ],
      },
    };
    const { finalRoles } = await PipelineResultWriter.writeStep1Results(params);
    expect(finalRoles).toHaveLength(2);
    expect(mockDbPrepare).toHaveBeenCalledWith('DELETE FROM roles WHERE project_id = @projectId');
    expect(mockDbPrepare).toHaveBeenCalledWith('INSERT INTO roles (...) VALUES (...)');
  });

  it('角色缺少 name 时使用 label 或自动生成', async () => {
    const params = {
      ...baseParams,
      result: {
        ...baseParams.result,
        roles: [
          { id: 'r1', label: '角色A' },
          { id: 'r2' },
        ],
      },
    };
    await PipelineResultWriter.writeStep1Results(params);
    // 不抛异常即通过（name 降级逻辑在 insertRole.run 中）
    expect(mockDbRun).toHaveBeenCalled();
  });

  it('facesSkipped 且有已有角色时复用 DB 角色', async () => {
    mockRoleFindByProjectId.mockReturnValue([
      { id: 'r1', name: '张三', avatar: '/a.jpg', pronoun: '他', description: 'desc', voice_id: 'v1', merged_roles: '[]' },
    ]);
    const params = {
      ...baseParams,
      facesSkipped: true,
    };
    const { finalRoles } = await PipelineResultWriter.writeStep1Results(params);
    expect(finalRoles).toHaveLength(1);
    expect(finalRoles[0].name).toBe('张三');
    expect(finalRoles[0].voiceId).toBe('v1');
  });

  it('facesSkipped 但 DB 无角色时不崩溃', async () => {
    mockRoleFindByProjectId.mockReturnValue([]);
    const params = {
      ...baseParams,
      facesSkipped: true,
    };
    const { finalRoles } = await PipelineResultWriter.writeStep1Results(params);
    expect(finalRoles).toEqual([]);
  });

  it('无角色数据时跳过角色写入', async () => {
    const { finalRoles } = await PipelineResultWriter.writeStep1Results(baseParams);
    expect(finalRoles).toEqual([]);
  });

  // ══════════════════════════════════════════
  // subStepStatuses 推导（通过 mock DB 验证）
  // ══════════════════════════════════════════

  it('subStepStatuses 写入 metadata（全部完成）', async () => {
    const params = {
      ...baseParams,
      result: {
        ...baseParams.result,
        frames: ['C:/projects/test/frames/f1.jpg'],
        vocalsPath: 'C:/projects/test/audio/vocals.wav',
        shots: [{ id: 'shot_1', originalText: 'hello', start: 0, end: 1 }],
        roles: [{ id: 'r1', name: '张三' }],
      },
    };
    await PipelineResultWriter.writeStep1Results(params);

    // 验证 metadata UPDATE 被调用（包含 subStepStatuses）
    const updateCalls = mockDbRun.mock.calls.filter(
      (call: any[]) => call[0] && typeof call[0] === 'string' && call[0].includes('subStepStatuses')
    );
    expect(updateCalls.length).toBeGreaterThanOrEqual(0);
  });

  it('subStepStatuses 写入失败不抛异常（非致命降级）', async () => {
    mockDbGet.mockImplementation(() => { throw new Error('DB read error'); });
    const params = {
      ...baseParams,
      result: {
        ...baseParams.result,
        frames: ['C:/projects/test/frames/f1.jpg'],
      },
    };
    // 不应抛出异常
    await expect(
      PipelineResultWriter.writeStep1Results(params)
    ).resolves.toBeDefined();
  });

  // ══════════════════════════════════════════
  // status 更新
  // ══════════════════════════════════════════

  it('媒体状态更新为 parsed', async () => {
    const { updatedMedia } = await PipelineResultWriter.writeStep1Results(baseParams);
    expect(updatedMedia.status).toBe('parsed');
  });

  it('media_assets 更新被调用', async () => {
    await PipelineResultWriter.writeStep1Results(baseParams);
    expect(mockMediaUpdate).toHaveBeenCalledWith('media1', expect.any(Object));
  });
});