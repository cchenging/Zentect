// 📁 路径: src/main/engine/search/__tests__/FrameRecallEntity.test.ts
// 🎯 实体定向补召（方案 A，2026-10-20）单测：
//   锁定 bug「文案显式点名的实体（照片）在 P3 帧召回里被整体语义淹没 ⇒ 池里根本没有该镜头」。
//   覆盖两件事：① 有判别力的实体词才参与补召 ② 补召合并后池量恒定、无命中时逐字节等于旧行为。

import { describe, it, expect } from 'vitest';
import {
  pickEntityWords,
  mergeEntityShots,
  type ShotRecallHit,
} from '../FrameRecallService';

function hit(chunkId: string, score: number): ShotRecallHit {
  return { chunkId, score, hitCount: 1, bestFrameHash: `h_${chunkId}`, bestTimeMs: 1000 };
}

function sem20(): ShotRecallHit[] {
  // 模拟语义召回上卷结果（按分降序）
  return Array.from({ length: 20 }, (_, i) => hit(`sem_${String(i).padStart(2, '0')}`, 0.9 - i * 0.01));
}

describe('pickEntityWords：实体词抽取 + 判别力红线', () => {
  const total = 787;                       // 与实测项目帧数同量级 ⇒ 红线 = max(3, ⌊787×5%⌋) = 39

  it('① 文案点名且不泛滥的实体词 ⇒ 命中', () => {
    const df = new Map([['照片', 10], ['合影', 4]]);
    const q = '可越是甜到发腻的誓言，越经不起一张照片的考验。 | 男女主角合影特写';
    expect(pickEntityWords(q, df, total)).toEqual(['照片', '合影']);
  });

  it('② 泛化词（命中帧数超红线）⇒ 弃用，不参与补召', () => {
    // 「手机」在本片命中 60 帧（> 39）⇒ 无判别力
    const df = new Map([['手机', 60], ['照片', 10]]);
    const q = '女主拿起手机翻看屏幕里的照片';
    expect(pickEntityWords(q, df, total)).toEqual(['照片']);
  });

  it('③ 词在文案里但片子里不存在（df=0）⇒ 不命中', () => {
    expect(pickEntityWords('她看了一张照片', new Map([['照片', 0]]), total)).toEqual([]);
  });

  it('④ 词表实体不在文案里 ⇒ 不命中（哪怕片子里有）', () => {
    expect(pickEntityWords('他们相拥告别', new Map([['照片', 10]]), total)).toEqual([]);
  });

  it('⑤ 帧数很少时红线保底为 3（防小池误杀）', () => {
    // frameTotal=20 ⇒ maxDf = max(3, 1) = 3；df=4 已超红线
    expect(pickEntityWords('照片', new Map([['照片', 4]]), 20)).toEqual([]);
    expect(pickEntityWords('照片', new Map([['照片', 3]]), 20)).toEqual(['照片']);
  });
});

describe('mergeEntityShots：池量恒定 + 无命中零行为变化', () => {
  it('① 无实体补召 ⇒ 逐字节等于旧行为（slice(0, topShots)）', () => {
    const sem = sem20();
    expect(mergeEntityShots(sem, [], 24)).toEqual(sem.slice(0, 24));
    expect(mergeEntityShots(sem, [], 10)).toEqual(sem.slice(0, 10));
  });

  it('② 实体补召新镜头 4 个 ⇒ 池总量仍为 topShots，补召镜头接在尾部', () => {
    const sem = sem20();
    const ent = [hit('photo_a', 0.56), hit('photo_b', 0.55), hit('photo_c', 0.54), hit('photo_d', 0.53)];
    const merged = mergeEntityShots(sem, ent, 24);
    expect(merged.length).toBe(24);
    expect(merged.map((s) => s.chunkId).slice(-4)).toEqual(['photo_a', 'photo_b', 'photo_c', 'photo_d']);
    // 语义召回被挤到 24-4=20 席（sem 恰好 20 个 ⇒ 一个不丢）
    expect(merged.map((s) => s.chunkId).slice(0, 20)).toEqual(sem.map((s) => s.chunkId));
  });

  it('③ 实体补召镜头已在语义池内 ⇒ 不重复占席，池不变', () => {
    const sem = sem20();
    const ent = [hit('sem_00', 0.56), hit('sem_01', 0.55)];
    const merged = mergeEntityShots(sem, ent, 24);
    expect(merged.map((s) => s.chunkId)).toEqual(sem.map((s) => s.chunkId));
  });

  it('④ 补召超出席位上上限 ⇒ 只取 reserved 个，池量仍恒定', () => {
    const sem = sem20();
    const ent = Array.from({ length: 10 }, (_, i) => hit(`photo_${i}`, 0.56 - i * 0.001));
    const merged = mergeEntityShots(sem, ent, 24, 6);
    expect(merged.length).toBe(24);
    expect(merged.filter((s) => s.chunkId.startsWith('photo_')).length).toBe(6);
  });

  it('⑤ 池上限小于 reserved ⇒ 不越界（语义侧保 1 席，补召席压到 topShots−1）', () => {
    const sem = sem20();
    const ent = Array.from({ length: 6 }, (_, i) => hit(`photo_${i}`, 0.56));
    const merged = mergeEntityShots(sem, ent, 4, 6);
    expect(merged.length).toBe(4);          // 1 语义 + 3 补召（reserved 被压到 topShots−1）
    expect(merged[0].chunkId).toBe('sem_00');
    expect(merged.filter((s) => s.chunkId.startsWith('photo_')).length).toBe(3);
  });
});
