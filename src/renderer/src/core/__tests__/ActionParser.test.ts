import { describe, it, expect, vi } from 'vitest';

// Mock the Zustand store
vi.mock('../../store/useStore', () => ({
  useEditorStore: {
    getState: () => ({
      mediaItems: [
        { id: 'm-001', filePath: '/media/demo.mp4', width: 1920, height: 1080, fps: 30 },
      ],
      shots: [],
      roles: [],
    }),
  },
  useStore: {
    getState: () => ({}),
  },
}));

// Mock parsers
vi.mock('../parsers', () => ({
  nodeParsers: new Map([
    ['vision-extract', {
      parse: (node: any, ctx: any) => ({
        nodeId: node.id,
        actionType: 'vision-extract',
        label: '视觉抽帧',
        params: { fps: 1, strategy: 'scene' },
        dependsOn: ctx.dependsOn || [],
        mergedInputs: { mediaPath: ctx.mediaPath },
      }),
    }],
    ['asr', {
      parse: (_node: any, _ctx: any) => null,
    }],
  ]),
  // ensure type export works
  INodeParser: class {},
}));

vi.mock('../commands', () => ({
  AICommandRegistry: { get: vi.fn() },
}));

vi.mock('../AppNotifier', () => ({
  AppNotifier: { success: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { ActionParser } = await import('../ActionParser');

describe('ActionParser', () => {

  describe('compileToSequence', () => {
    it('should return empty for no process nodes', () => {
      const nodes: any[] = [
        { id: 'n1', type: 'sourceNode', data: { label: '媒体源' } },
        { id: 'n2', type: 'playerNode', data: { label: '播放器' } },
      ];
      const result = ActionParser.compileToSequence(nodes, []);
      expect(result).toEqual([]);
    });

    it('should sort nodes in topological order (simple linear)', () => {
      const nodes: any[] = [
        { id: 'n-a', type: 'processNode', data: { actionType: 'vision-extract', label: '抽帧' } },
        { id: 'n-b', type: 'processNode', data: { actionType: 'vision-extract', label: '抽帧2' } },
      ];
      const edges: any[] = [
        { source: 'n-a', target: 'n-b' },
      ];
      const result = ActionParser.compileToSequence(nodes, edges);
      expect(result.length).toBe(2);
      expect(result[0].nodeId).toBe('n-a');
      expect(result[1].nodeId).toBe('n-b');
    });

    it('should detect cycles and throw', () => {
      const nodes: any[] = [
        { id: 'n-a', type: 'processNode', data: { actionType: 'vision-extract' } },
        { id: 'n-b', type: 'processNode', data: { actionType: 'vision-extract' } },
      ];
      const edges: any[] = [
        { source: 'n-a', target: 'n-b' },
        { source: 'n-b', target: 'n-a' },
      ];
      expect(() => ActionParser.compileToSequence(nodes, edges)).toThrow();
    });

    it('should include dependsOn from incoming edges', () => {
      const nodes: any[] = [
        { id: 'n-a', type: 'processNode', data: { actionType: 'vision-extract' } },
        { id: 'n-b', type: 'processNode', data: { actionType: 'vision-extract' } },
      ];
      const edges: any[] = [{ source: 'n-a', target: 'n-b' }];
      const result = ActionParser.compileToSequence(nodes, edges);
      const nodeB = result.find(n => n.nodeId === 'n-b');
      expect(nodeB?.dependsOn).toEqual(['n-a']);
    });

    it('should resolve mediaPath from parent node mediaId', () => {
      const nodes: any[] = [
        { id: 'n-a', type: 'processNode', data: { actionType: 'vision-extract', mediaId: 'm-001' } },
        { id: 'n-b', type: 'processNode', data: { actionType: 'vision-extract' } },
      ];
      const edges: any[] = [{ source: 'n-a', target: 'n-b' }];
      const result = ActionParser.compileToSequence(nodes, edges);
      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle disconnected DAG (parallel nodes)', () => {
      const nodes: any[] = [
        { id: 'n-a', type: 'processNode', data: { actionType: 'vision-extract' } },
        { id: 'n-b', type: 'processNode', data: { actionType: 'vision-extract' } },
      ];
      const result = ActionParser.compileToSequence(nodes, []);
      expect(result.length).toBe(2);
    });
  });

  describe('compile', () => {
    it('should strip visual props from nodes', () => {
      const nodes: any[] = [
        { id: 'n1', type: 'processNode', position: { x: 100, y: 200 }, width: 200, data: { actionType: 'vision-extract' } },
      ];
      const result = ActionParser.compile(nodes, []);
      expect(result.nodes[0]).not.toHaveProperty('position');
      expect(result.nodes[0]).not.toHaveProperty('width');
      expect(result.nodes[0].data).toEqual({ actionType: 'vision-extract' });
    });

    it('should throw for empty nodes', () => {
      expect(() => ActionParser.compile([], [])).toThrow();
    });
  });
});
