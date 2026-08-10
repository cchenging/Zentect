// 📁 路径：src/modules/export/__tests__/Registry.test.ts
// 注册表测试：验证 buildExportRegistry 注册全部出口、fail-fast 校验行为。
//
// 设计原则：错就错、不降级、不兜底 —— 未知出口/重复注册/非法输入均抛错暴露。

import { describe, it, expect } from 'vitest';
import { buildExportRegistry } from '../createExportRegistry';
import { ExportRegistry } from '../contracts/ExportRegistry';
import type { IExporter } from '../contracts/IExporter';
import type { ExportJob } from '../contracts/ExportJob';

describe('buildExportRegistry', () => {
  it('应注册 jianying 与 mp4 两个出口', () => {
    const registry = buildExportRegistry();
    expect(registry.has('jianying')).toBe(true);
    expect(registry.has('mp4')).toBe(true);
    expect(registry.ids().sort()).toEqual(['jianying', 'mp4']);
  });

  it('get 未知出口应抛错（fail-fast，不返回 undefined 兜底）', () => {
    const registry = buildExportRegistry();
    expect(() => registry.get('unknown')).toThrow(/未知导出出口/);
  });

  it('重复注册应抛错暴露冲突', () => {
    const registry = new ExportRegistry();
    const fake: IExporter = {
      id: 'mp4',
      validate: () => undefined,
      export: async () => ({ exporterId: 'mp4', success: true }),
    };
    registry.register(fake);
    expect(() => registry.register(fake)).toThrow(/重复注册/);
  });

  it('jianying 出口缺少 projectId 校验应抛错', () => {
    const registry = buildExportRegistry();
    const exporter = registry.get('jianying');
    const job: ExportJob = { projectId: '' };
    expect(() => exporter.validate(job)).toThrow(/缺少 projectId/);
  });

  it('jianying 出口缺少 input 载荷校验应抛错', () => {
    const registry = buildExportRegistry();
    const exporter = registry.get('jianying');
    const job: ExportJob = { projectId: 'p1', payload: {} };
    expect(() => exporter.validate(job)).toThrow(/缺少 input/);
  });

  it('mp4 出口缺少 project 中间模型校验应抛错', () => {
    const registry = buildExportRegistry();
    const exporter = registry.get('mp4');
    const job: ExportJob = { projectId: 'p1', project: undefined };
    expect(() => exporter.validate(job)).toThrow(/缺少中间数据模型/);
  });
});