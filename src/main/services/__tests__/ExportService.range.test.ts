// 📁 路径：src/main/services/__tests__/ExportService.range.test.ts
// 测试导出范围过滤（S8 片段导出）的纯函数 applyExportRange

import { describe, it, expect } from 'vitest';
import { applyExportRange } from '../ExportService';
import { AppError } from '../../../modules/infra/error/AppError';

/** 构造一条带 id 的镜头 */
function makeShot(id: string) {
  return { id, text: `文本-${id}` };
}

describe('applyExportRange（导出范围过滤）', () => {
  const shots = [makeShot('a'), makeShot('b'), makeShot('c')];

  it('范围非 selected 时应原样返回全部镜头', () => {
    expect(applyExportRange(shots, 'all', ['a'])).toEqual(shots);
    expect(applyExportRange(shots, undefined)).toEqual(shots);
  });

  it('范围 selected 时应仅保留 ids 命中的镜头', () => {
    const result = applyExportRange(shots, 'selected', ['b']);
    expect(result).toEqual([makeShot('b')]);
  });

  it('范围 selected 且命中多个时应按原顺序保留', () => {
    const result = applyExportRange(shots, 'selected', ['c', 'a']);
    expect(result.map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('范围 selected 但无任何命中时应抛 AppError（fail-fast，不降级为全部）', () => {
    expect(() => applyExportRange(shots, 'selected', ['nonexistent'])).toThrow(AppError);
    expect(() => applyExportRange(shots, 'selected', [])).toThrow(AppError);
  });
});