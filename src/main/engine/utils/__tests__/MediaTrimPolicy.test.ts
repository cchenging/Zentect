/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { applyToChunks } from '../MediaTrimPolicy';

// ============================================================
// applyToChunks：OP/ED 源坐标过滤（模式 A 契约）+ ContentGuard 保护 + 纯字卡剔除
// 🔧 2026-09-05 重构：不再坐标平移（body），产物坐标恒为【源坐标】，
//   与 chunk.filePath（源视频）自洽 —— 预览/导出按源坐标直接取窗，杜绝"片头/错位"类消费端 bug。
// ============================================================
describe('applyToChunks：源坐标过滤 + 字卡剔除与关键词保护边界', () => {
  // 参照老舅09：OP=77.767s（77767ms），ED 起点=145.067s
  const TRIM = { trimStartMs: 77767, trimEndMs: 0 };

  it('OP 尾部 15s 内的强剧情关键词画面（如牌匾裂纹）受保护夹回正剧起点（源坐标保留，回归 8-21 修复）', () => {
    const chunks: any[] = [
      { id: 'c_paiban', startMs: 66000, endMs: 71600, description: '手指抚摸牌匾裂纹的特写', keywords: ['牌匾'] },
    ];
    const out = applyToChunks(chunks, TRIM).chunks;
    // 源坐标：夹到正剧起点 77767，保留原时长 5600ms（endMs ≈ 83367）
    expect(out.length).toBe(1);
    expect(out[0].startMs).toBe(77767);
    expect(out[0].endMs).toBe(77767 + (71600 - 66000));
  });

  it('OP 尾部含"出品/预告"字卡特征的字卡画面即使混有剧情关键词也跳过保护被滤除', () => {
    const chunks: any[] = [
      {
        id: 'c_logo',
        startMs: 70000,
        endMs: 76000,
        description: '片尾预告：老字号鼎庆楼荣誉出品 下集敬请期待',
        keywords: ['鼎庆楼', '出品'],
      },
    ];
    const out = applyToChunks(chunks, TRIM).chunks;
    expect(out.length).toBe(0); // 全落在 OP 内 + 字卡 → 直接滤除，不得软拉回
  });

  it('正剧窗内的普通画面保留且坐标保持源坐标（不平移）', () => {
    const chunks: any[] = [
      { id: 'c_body', startMs: 80000, endMs: 83000, description: '男子坐在桌边', keywords: [] },
    ];
    const out = applyToChunks(chunks, TRIM).chunks;
    expect(out.length).toBe(1);
    expect(out[0].startMs).toBe(80000); // 源坐标原样保留（不再 -OP）
    expect(out[0].endMs).toBe(83000);
  });

  it('跨 OP 边界的切片收紧到正剧起点（源坐标收紧）', () => {
    const chunks: any[] = [
      { id: 'c_cross', startMs: 75000, endMs: 79000, description: '正剧开场画面', keywords: [] },
    ];
    const out = applyToChunks(chunks, TRIM).chunks;
    expect(out.length).toBe(1);
    expect(out[0].startMs).toBe(77767);
    expect(out[0].endMs).toBe(79000);
  });

  it('纯 OP 中段画面（不触 OP 线、无关键词）正常滤除', () => {
    const chunks: any[] = [
      { id: 'c_op_mid', startMs: 20000, endMs: 40000, description: '片头橙色毛笔字剧名', keywords: [] },
    ];
    const out = applyToChunks(chunks, TRIM).chunks;
    expect(out.length).toBe(0);
  });

  it('无 trim（0/0）时切片原样直通（不误伤无裁剪项目）', () => {
    const chunks: any[] = [
      { id: 'c0', startMs: 0, endMs: 31640, description: '橙色毛笔字老舅', keywords: [] },
    ];
    const out = applyToChunks(chunks, { trimStartMs: 0, trimEndMs: 0 }).chunks;
    expect(out.length).toBe(1);
    expect(out[0].startMs).toBe(0);
  });
});
