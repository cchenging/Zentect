import { describe, it, expect, vi } from 'vitest';

vi.mock('../../store/constants', () => ({
  CONNECTION_RULES: {
    sourceNode: ['processNode', 'playerNode'],
    processNode: ['processNode', 'vectorNode', 'scriptNode', 'playerNode'],
    vectorNode: ['scriptNode'],
    scriptNode: ['processNode', 'playerNode'],
    playerNode: [],
  },
}));

const { WorkflowValidator } = await import('../WorkflowValidator');

describe('WorkflowValidator', () => {
  const sourceNode = { id: 's1', type: 'sourceNode', data: { label: '媒体源' } };
  const processNode = { id: 'p1', type: 'processNode', data: { label: '视觉抽帧' } };
  const scriptNode = { id: 'sc1', type: 'scriptNode', data: { label: '剧本' } };
  const vectorNode = { id: 'v1', type: 'vectorNode', data: { label: '向量库' } };
  const playerNode = { id: 'pl1', type: 'playerNode', data: { label: '播放器' } };

  it('should allow sourceNode → processNode', () => {
    const err = WorkflowValidator.validateConnection(
      { source: 's1', target: 'p1', sourceHandle: '', targetHandle: '' },
      [sourceNode, processNode] as any
    );
    expect(err).toBeNull();
  });

  it('should block self-loop', () => {
    const err = WorkflowValidator.validateConnection(
      { source: 's1', target: 's1', sourceHandle: '', targetHandle: '' },
      [sourceNode] as any
    );
    expect(err).not.toBeNull();
  });

  it('should block vectorNode → processNode', () => {
    const err = WorkflowValidator.validateConnection(
      { source: 'v1', target: 'p1', sourceHandle: '', targetHandle: '' },
      [vectorNode, processNode] as any
    );
    expect(err).not.toBeNull();
  });

  it('should allow vectorNode → scriptNode', () => {
    const err = WorkflowValidator.validateConnection(
      { source: 'v1', target: 'sc1', sourceHandle: '', targetHandle: '' },
      [vectorNode, scriptNode] as any
    );
    expect(err).toBeNull();
  });

  it('should block playerNode → anything (no outputs)', () => {
    const err = WorkflowValidator.validateConnection(
      { source: 'pl1', target: 's1', sourceHandle: '', targetHandle: '' },
      [playerNode, sourceNode] as any
    );
    expect(err).not.toBeNull();
  });
});
