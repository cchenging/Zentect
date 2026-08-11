// Module: media/frames - SmartFramePostProcessor 纯函数单元测试
// 仅测试不依赖磁盘/sharp 读取的确定性纯函数（清晰度/去重/时序推导由 process 集成验证）

import { describe, it, expect, vi, beforeAll, afterEach, type MockInstance } from 'vitest';
import { SmartFramePostProcessor } from '../backend/SmartFramePostProcessor';

describe('SmartFramePostProcessor.formatTimeMs', () => {
  it('应格式化毫秒为 mm:ss.SSS', () => {
    expect(SmartFramePostProcessor.formatTimeMs(4250)).toBe('00:04.250');
  });

  it('超过一分钟应进位', () => {
    expect(SmartFramePostProcessor.formatTimeMs(65400)).toBe('01:05.400');
  });

  it('负值应被钳制为 0', () => {
    expect(SmartFramePostProcessor.formatTimeMs(-1)).toBe('00:00.000');
  });
});

describe('SmartFramePostProcessor.hammingDistance', () => {
  it('相同哈希距离为 0', () => {
    expect(SmartFramePostProcessor.hammingDistance('1010', '1010')).toBe(0);
  });

  it('逐位不同数即汉明距离', () => {
    expect(SmartFramePostProcessor.hammingDistance('1011', '1000')).toBe(2);
  });

  it('长度不等返回最大值（视为不可比）', () => {
    expect(SmartFramePostProcessor.hammingDistance('101', '1011')).toBe(Number.MAX_SAFE_INTEGER);
  });
});

// ============= P1 集成链路验证（vi.spyOn mock sharp / 磁盘访问，不访问真实文件）=============
/** 创建假 framePath 数组（n 帧） */
function fakeFiles(n: number, root = 'C:/fake/temp_frames') {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`${root}/shot_${i.toString().padStart(6, '0')}.jpg`);
  }
  return out;
}

/** 为 64 位 aHash 构建一对汉明距离 = diff 的字符串（前 n 位翻转） */
function hashWithHammingDistance(base: string, diff: number): string {
  const arr = base.split('');
  for (let i = 0; i < Math.min(diff, arr.length); i++) {
    arr[i] = arr[i] === '0' ? '1' : '0';
  }
  return arr.join('');
}

describe('SmartFramePostProcessor.process · P1 镜内差分采样集成链路（mock 免磁盘）', () => {
  // 1️⃣ Spy 挂载：每次测试前 mock 掉所有 sharp/磁盘相关静态方法
  const assessClaritySpy = vi.spyOn(SmartFramePostProcessor, 'assessClarity' as any) as unknown as MockInstance<(fp: string) => Promise<number>>;
  const assessLumaSpy = vi.spyOn(SmartFramePostProcessor, 'assessLuma' as any) as unknown as MockInstance<(fp: string) => Promise<number>>;
  const computeHashSpy = vi.spyOn(SmartFramePostProcessor, 'computeHash' as any) as unknown as MockInstance<(fp: string) => Promise<string>>;
  const tryUnlinkSpy = vi.spyOn(SmartFramePostProcessor, 'tryUnlink' as any) as unknown as MockInstance<(fp: string) => void>;

  beforeAll(() => {
    assessClaritySpy.mockResolvedValue(500); // 清晰度过关
    assessLumaSpy.mockResolvedValue(128);    // 亮度过关
    tryUnlinkSpy.mockImplementation(() => { /* noop：不会真删 */ });
  });
  afterEach(() => {
    computeHashSpy.mockReset(); // 每用例清空 computeHash 的 mockImplementation（避免 hash 序列污染）
  });

  // 第 1 条集成断言：sceneIndex 差分分裂（hamming>40 边界 → 新 sceneIndex 从 1 重新编号）
  it('[P1-集成-1] sceneIndex 差分分裂：帧间 hash 差分 45 超过阈值 40 → sceneIndex 从 1 跳变到 2', async () => {
    // 5 帧：构造 hash 序列 → 相邻对 hamming 距离 [5, 45, 5, 5]（只有 pairIndex=2 的差分>40，触发一次 scene split）
    const files = fakeFiles(5);
    const base = '0'.repeat(64);
    const h0 = base;
    const h1 = hashWithHammingDistance(h0, 5);   // ham(0,1)=5 (同一场景)
    const h2 = hashWithHammingDistance(h1, 45);  // ham(1,2)=45 → 超阈值 40 → 新 scene
    const h3 = hashWithHammingDistance(h2, 5);   // ham(2,3)=5
    const h4 = hashWithHammingDistance(h3, 5);   // ham(3,4)=5
    const hashSeq = [h0, h1, h2, h3, h4];
    // 计算预期：hamming 每对 → 验证 hash 序列是否正确（自测断言）
    expect(SmartFramePostProcessor.hammingDistance(h0, h1)).toBe(5);
    expect(SmartFramePostProcessor.hammingDistance(h1, h2)).toBe(45);
    expect(SmartFramePostProcessor.hammingDistance(h2, h3)).toBe(5);
    expect(SmartFramePostProcessor.hammingDistance(h3, h4)).toBe(5);

    // 安装 computeHash mock：按 framePath 在 files 中顺序返回对应 hash
    computeHashSpy.mockImplementation(async (fp: string) => {
      const idx = files.indexOf(fp);
      return hashSeq[idx] ?? base;
    });
    const result = await SmartFramePostProcessor.process(files, {
      strategy: 'AUTO_ADAPTIVE',
      fps: 1,
      dedupThreshold: 0, // 关闭去重（此用例关注差分分裂场景，hash 差分 5 等于默认阈值 5 会误触发 dedup drop；关闭后 5 帧全进 kept）
      densityPreset: undefined, // 不跑 BudgetClipper，专注 scene split
      maxFrames: undefined,
      silentBudgetClipper: true,
    });
    expect(result.kept).toHaveLength(5); // 无裁剪
    // sceneIndex 预期：0-1 为同场景(sceneIndex=1)，2-4 为新场景(sceneIndex=2)
    // 注：splitSceneBoundary 从 frame i=2 开始（diffToPrev = hamming(h1,h2)=45）→ currentScene++ → 2
    expect(result.kept[0].sceneIndex).toBe(1);
    expect(result.kept[1].sceneIndex).toBe(1); // diff=5 未触发分裂
    expect(result.kept[2].sceneIndex).toBe(2); // diff=45 >40 触发分裂
    expect(result.kept[3].sceneIndex).toBe(2);
    expect(result.kept[4].sceneIndex).toBe(2);
  });

  // 第 2 条集成断言：UNIFORM_FPS gate（即使差分有跳变，⑥-1 全流程跳过，action_peak 不进白名单）
  it('[P1-集成-2] UNIFORM_FPS strategy gate：即使存在动作峰差分序列，也不跑 InSceneDiffSampler（kept 数量与 kept sceneIndex 未分裂，仍为 P0 递增序号）', async () => {
    // 构造 5 帧 hash 序列，相邻对 hamming = [8,45,7,9]（模拟有动作峰，对应帧 i=2 的 diffToPrev=45 为中心跳变）
    const files = fakeFiles(5);
    const base = '0'.repeat(64);
    const h0 = base;
    const h1 = hashWithHammingDistance(h0, 8);
    const h2 = hashWithHammingDistance(h1, 45);
    const h3 = hashWithHammingDistance(h2, 7);
    const h4 = hashWithHammingDistance(h3, 9);
    const hashSeq = [h0, h1, h2, h3, h4];
    computeHashSpy.mockImplementation(async (fp: string) => {
      const idx = files.indexOf(fp);
      return hashSeq[idx] ?? base;
    });
    // UNIFORM_FPS 策略：shouldRunDiff = false
    const result = await SmartFramePostProcessor.process(files, {
      strategy: 'UNIFORM_FPS',
      fps: 1,
      densityPreset: undefined,
      maxFrames: undefined,
      silentBudgetClipper: true,
    });
    expect(result.kept).toHaveLength(5);
    // P0 递增序号（未被差分分裂覆写）：sceneIndex 1..5 连续
    const sceneIdx = result.kept.map(f => f.sceneIndex);
    expect(sceneIdx).toEqual([1, 2, 3, 4, 5]);
  });

  // 第 3 条集成断言：回滚安全（diffSampling.enabled=false → kept 数量与 P0 baseline 完全一致）
  it('[P1-集成-3] 回滚安全：diffSampling.enabled=false → 5 帧场景全部保留（与 diff=on 时 kept 数量 ±0 baseline）', async () => {
    const files = fakeFiles(5);
    // computeHash 全相同 hash（hammingDistance 全 =0 → kept 每帧都过 dedup，所以 5 帧都会因为重复被 drop？—— dedupThreshold 默认 5，ham(prev,cur)=0 ≤ 5 → 会！→ 所以构造 5 个 hamming=10 大于 5 的 hash，确保都不被 dedup drop → kept=5）
    const base = '0'.repeat(64);
    const hashSeq: string[] = [];
    for (let i = 0; i < 5; i++) hashSeq.push(hashWithHammingDistance(base, i * 10 + 10)); // 相邻 hamming = 10 大于 dedupThreshold(=5)
    // 验证相邻 hammingDistance ≥ 10：
    for (let j = 1; j < 5; j++) {
      const ham = SmartFramePostProcessor.hammingDistance(hashSeq[j - 1], hashSeq[j]);
      expect(ham).toBeGreaterThan(5);
    }
    computeHashSpy.mockImplementation(async (fp: string) => {
      const idx = files.indexOf(fp);
      return hashSeq[idx] ?? base;
    });

    // 关闭差分 vs 开启差分（同一 hash 序列，不同开关 → kept 数量完全相等，±0 baseline 回滚安全）
    const [baselineOff, baselineOn] = await Promise.all([
      SmartFramePostProcessor.process(files, {
        strategy: 'AUTO_ADAPTIVE', fps: 1, densityPreset: undefined, maxFrames: undefined, silentBudgetClipper: true,
        diffSampling: { enabled: false },
      }),
      SmartFramePostProcessor.process(files, {
        strategy: 'AUTO_ADAPTIVE', fps: 1, densityPreset: undefined, maxFrames: undefined, silentBudgetClipper: true,
        diffSampling: { enabled: true },
      }),
    ]);
    expect(baselineOff.kept).toHaveLength(5);
    expect(baselineOn.kept).toHaveLength(5);
    // 回滚安全不变式：两者数量相等（±0 baseline）
    expect(baselineOff.kept.length).toBe(baselineOn.kept.length);
    // Baseline 稳定性更强校验：两结果帧集合完全相同（set eq），只 sceneIndex 可能不同
    const pathsOff = new Set(baselineOff.kept.map(f => f.framePath));
    const pathsOn = new Set(baselineOn.kept.map(f => f.framePath));
    expect(pathsOff.size).toBe(pathsOn.size);
    for (const p of pathsOff) expect(pathsOn.has(p)).toBe(true);
  });
});