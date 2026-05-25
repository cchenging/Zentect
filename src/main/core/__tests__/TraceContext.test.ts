import { describe, it, expect, beforeEach } from 'vitest';
import { TraceContext } from '../TraceContext';

describe('TraceContext', () => {
  beforeEach(() => {
    TraceContext.endTrace();
    // 清理内部状态以隔离测试
    TraceContext['activeSpans'].clear();
  });

  describe('startTrace', () => {
    it('生成非空的 traceId', () => {
      const traceId = TraceContext.startTrace('test_op');
      expect(traceId).toBeTruthy();
      expect(traceId.length).toBeGreaterThan(0);
    });

    it('每次调用生成不同的 traceId', () => {
      const id1 = TraceContext.startTrace('op1');
      TraceContext.endTrace();
      const id2 = TraceContext.startTrace('op2');
      expect(id1).not.toBe(id2);
    });

    it('将生成的 traceId 设为当前追踪', () => {
      const traceId = TraceContext.startTrace('pipeline_run');
      expect(TraceContext.getTraceId()).toBe(traceId);
    });
  });

  describe('getTraceId', () => {
    it('追踪开始前返回 null', () => {
      expect(TraceContext.getTraceId()).toBeNull();
    });

    it('追踪中返回当前 traceId', () => {
      const traceId = TraceContext.startTrace('test');
      expect(TraceContext.getTraceId()).toBe(traceId);
    });

    it('追踪结束后返回 null', () => {
      TraceContext.startTrace('test');
      TraceContext.endTrace();
      expect(TraceContext.getTraceId()).toBeNull();
    });
  });

  describe('startSpan', () => {
    it('在活跃追踪中创建非空 spanId', () => {
      TraceContext.startTrace('pipeline');
      const spanId = TraceContext.startSpan('step:extract_frames');
      expect(spanId).toBeTruthy();
      expect(spanId.length).toBeGreaterThan(0);
    });

    it('无活跃追踪时返回空字符串', () => {
      const spanId = TraceContext.startSpan('orphan');
      expect(spanId).toBe('');
    });

    it('多个 span 拥有不同的 spanId', () => {
      TraceContext.startTrace('pipeline');
      const s1 = TraceContext.startSpan('step:1');
      const s2 = TraceContext.startSpan('step:2');
      expect(s1).not.toBe(s2);
    });
  });

  describe('endSpan', () => {
    it('结束 span 后可获取其耗时', () => {
      TraceContext.startTrace('pipeline');
      const spanId = TraceContext.startSpan('step:test');
      TraceContext.endSpan(spanId);
      const duration = TraceContext.getSpanDuration(spanId);
      expect(duration).toBeGreaterThanOrEqual(0);
    });

    it('未结束的 span 返回 -1', () => {
      TraceContext.startTrace('pipeline');
      const spanId = TraceContext.startSpan('step:unfinished');
      const duration = TraceContext.getSpanDuration(spanId);
      expect(duration).toBe(-1);
    });

    it('不存在的 spanId 返回 -1', () => {
      const duration = TraceContext.getSpanDuration('nonexistent');
      expect(duration).toBe(-1);
    });
  });

  describe('enrichLog', () => {
    it('在追踪中为日志添加 trace 前缀', () => {
      TraceContext.startTrace('test');
      const enriched = TraceContext.enrichLog('处理中');
      expect(enriched).toMatch(/^\[trace:\w{8}\] 处理中$/);
    });

    it('无追踪时不修改日志', () => {
      const message = '普通日志';
      expect(TraceContext.enrichLog(message)).toBe(message);
    });
  });

  describe('endTrace', () => {
    it('结束追踪后将 currentTraceId 重置为 null', () => {
      TraceContext.startTrace('test');
      TraceContext.endTrace();
      expect(TraceContext.getTraceId()).toBeNull();
    });

    it('无活跃追踪时调用不会出错', () => {
      expect(() => TraceContext.endTrace()).not.toThrow();
    });
  });
});
