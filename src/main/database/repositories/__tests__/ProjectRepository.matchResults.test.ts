/**
 * ProjectRepository.sanitizeMatchResultsForPersist 单元测试
 * 验证步骤5 匹配结果落盘前的 chunkData 大字段裁剪逻辑
 */
import { describe, it, expect } from 'vitest';
import { ProjectRepository } from '../ProjectRepository';

describe('ProjectRepository.sanitizeMatchResultsForPersist', () => {
  it('应裁剪 chunkData 中的 visionEmbedding/colorHistogram/clipZhEmbedding 大字段', () => {
    const results = [{
      shotId: 's1',
      score: 0.95,
      chunkData: {
        id: 'chunk_001',
        startMs: 0,
        endMs: 3000,
        coverPath: 'C:/cover.jpg',
        filePath: 'C:/video.mp4',
        visionEmbedding: new Array(512).fill(0.1),
        colorHistogram: [1, 2, 3],
        clipZhEmbedding: new Array(512).fill(0.05), // KM 图像特征缓存回写，512 维
      },
    }];
    const cleaned = ProjectRepository.sanitizeMatchResultsForPersist(results);
    expect(cleaned[0].chunkData).not.toHaveProperty('visionEmbedding');
    expect(cleaned[0].chunkData).not.toHaveProperty('colorHistogram');
    expect(cleaned[0].chunkData).not.toHaveProperty('clipZhEmbedding');
    // 前端消费的轻量字段必须保留
    expect(cleaned[0].chunkData.id).toBe('chunk_001');
    expect(cleaned[0].chunkData.startMs).toBe(0);
    expect(cleaned[0].chunkData.filePath).toBe('C:/video.mp4');
  });

  it('无 chunkData 的匹配结果应原样返回（不新增字段）', () => {
    const results = [{ shotId: 's1', score: 0.9, confirmed: false }];
    expect(ProjectRepository.sanitizeMatchResultsForPersist(results)[0]).toEqual(results[0]);
  });

  it('chunkData 非对象时应原样返回', () => {
    const results = [{ shotId: 's1', chunkData: null }];
    expect(ProjectRepository.sanitizeMatchResultsForPersist(results)[0]).toEqual(results[0]);
  });
});
