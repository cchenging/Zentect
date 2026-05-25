import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPut = vi.fn().mockResolvedValue(undefined);
const mockGet = vi.fn().mockResolvedValue(undefined);
const mockDelete = vi.fn().mockResolvedValue(undefined);
const mockUpdate = vi.fn().mockResolvedValue(undefined);
const mockWhere = vi.fn().mockReturnThis();
const mockEquals = vi.fn().mockReturnThis();
const mockToArray = vi.fn().mockResolvedValue([]);

vi.mock('../../database/localDB', () => {
  const mockTable = {
    put: mockPut,
    get: mockGet,
    delete: mockDelete,
    update: mockUpdate,
    where: mockWhere,
    equals: mockEquals,
    toArray: mockToArray,
  };
  return {
    localDB: { projectDrafts: mockTable },
    ProjectDraft: class {},
  };
});

const { DraftService } = await import('../../services/DraftService');

describe('DraftService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should save draft with all fields', async () => {
    await DraftService.saveDraft('proj-1', 'snapshot-json', '测试工作流', []);
    expect(mockPut).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        canvasSnapshot: 'snapshot-json',
        name: '测试工作流',
        syncStatus: 'PENDING',
      })
    );
  });

  it('should use fallback name when name not provided', async () => {
    await DraftService.saveDraft('proj-1', 'snapshot-json');
    expect(mockPut).toHaveBeenCalledWith(
      expect.objectContaining({ name: '未命名工作流' })
    );
  });

  it('should clear draft', async () => {
    await DraftService.clearDraft('proj-1');
    expect(mockDelete).toHaveBeenCalledWith('proj-1');
  });

  it('should mark draft as synced', async () => {
    await DraftService.markAsSynced('proj-1');
    expect(mockUpdate).toHaveBeenCalledWith('proj-1', { syncStatus: 'SYNCED' });
  });

  it('should handle save errors gracefully', async () => {
    mockPut.mockRejectedValueOnce(new Error('DB error'));
    await expect(DraftService.saveDraft('proj-1', 'snap')).resolves.not.toThrow();
  });

  it('should handle clear errors gracefully', async () => {
    mockDelete.mockRejectedValueOnce(new Error('Not found'));
    await expect(DraftService.clearDraft('proj-1')).resolves.not.toThrow();
  });

  it('should return null from getCanvasDraft when projectId empty', async () => {
    const result = await DraftService.getCanvasDraft('');
    expect(result).toBeNull();
  });

  it('should return null from getCanvasDraft when no draft found', async () => {
    mockGet.mockResolvedValueOnce(undefined);
    const result = await DraftService.getCanvasDraft('proj-none');
    expect(result).toBeNull();
  });

  it('should parse canvas snapshot from draft', async () => {
    mockGet.mockResolvedValueOnce({
      projectId: 'proj-1',
      canvasSnapshot: JSON.stringify({
        nodes: [{ id: 'n1' }],
        edges: [{ source: 'n1', target: 'n2' }],
      }),
    });
    const result = await DraftService.getCanvasDraft('proj-1');
    expect(result).toEqual({
      nodes: [{ id: 'n1' }],
      edges: [{ source: 'n1', target: 'n2' }],
    });
  });

  it('should return null for corrupted canvas snapshot', async () => {
    mockGet.mockResolvedValueOnce({
      projectId: 'proj-1',
      canvasSnapshot: 'invalid-json{',
    });
    const result = await DraftService.getCanvasDraft('proj-1');
    expect(result).toBeNull();
  });
});
