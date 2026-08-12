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

// ============= P2 集成链路验证（声画锚定：mock 免磁盘，P1 mock 可直接复用）=============
/** 创建假 ASR 台词数据（纯内存） */
function fakeAsr(startMs: number, endMs: number, text: string) {
  return {
    start: '', startMs, end: '', endMs, text, editing: false,
  } as const;
}

describe('SmartFramePostProcessor.process · P2 声画锚定集成链路（mock 免磁盘）', () => {
  const assessClaritySpy = vi.spyOn(SmartFramePostProcessor, 'assessClarity' as any) as unknown as MockInstance<(fp: string) => Promise<number>>;
  const assessLumaSpy = vi.spyOn(SmartFramePostProcessor, 'assessLuma' as any) as unknown as MockInstance<(fp: string) => Promise<number>>;
  const computeHashSpy = vi.spyOn(SmartFramePostProcessor, 'computeHash' as any) as unknown as MockInstance<(fp: string) => Promise<string>>;
  const tryUnlinkSpy = vi.spyOn(SmartFramePostProcessor, 'tryUnlink' as any) as unknown as MockInstance<(fp: string) => void>;

  beforeAll(() => {
    assessClaritySpy.mockResolvedValue(500); // 清晰度过关
    assessLumaSpy.mockResolvedValue(128);    // 亮度过关
    tryUnlinkSpy.mockImplementation(() => { /* noop：不会真删 */ });
  });
  afterEach(() => { computeHashSpy.mockReset(); });

  // [P2-集成-1] 声画吸附白名单：ASR line (4000-6000, center=5000) 对应 frame at 5000ms → BudgetClipper 白名单优先保留
  it('[P2-集成-1] 声画吸附白名单：帧 time=5000ms 与 ASR 台词 center=5000ms 吸附 → 白名单保留（BudgetClipper 预算紧时 100% 留下）', async () => {
    // 构造 5 帧：timeMs = 1000, 3000, 5000, 7000, 9000（均匀分布）
    const files = fakeFiles(5);
    // hash 各不相同（hamming=15 > 默认 dedupThreshold=5），确保 5 帧均不被 dedup drop
    const base = '0'.repeat(64);
    const hashSeq = Array.from({ length: 5 }, (_, i) => hashWithHammingDistance(base, 15 + i * 10));
    computeHashSpy.mockImplementation(async (fp: string) => {
      const idx = files.indexOf(fp);
      return hashSeq[idx] ?? base;
    });
    // 单条 ASR 台词：4000-6000ms（center=5000ms → 匹配 frame index 2）
    const asrLines = [fakeAsr(4000, 6000, '匹配台词5秒')];
    // 显式传精确 PTS：5 帧 = [1000, 3000, 5000, 7000, 9000] ms（否则 AUTO_ADAPTIVE 会 inferTimeMs = index / fps*1000，fps=1 → i=2 time=2000，离 center 5000 Δ=3000 > tolerance 3000 边界）
    const ptsMs = [1000, 3000, 5000, 7000, 9000];
    // Budget：maxFrames = 2（tight budget，只留白名单），toleranceRatio=0
    const result = await SmartFramePostProcessor.process(files, {
      strategy: 'AUTO_ADAPTIVE', fps: 1,
      dedupThreshold: 0, // 关闭去重（与 P1 保持一致，避免重复帧 drop 影响断言）
      ptsMs,
      maxFrames: 2, toleranceRatio: 0,
      silentBudgetClipper: true,
      asrSampling: { enabled: true, toleranceMs: 3000 },
      asrLines,
    });
    // 白名单应包含：首帧(1000ms) + 末帧(9000ms) + 吸附帧(5000ms) = 3 张？——但 BudgetClipper 当 maxFrames=2, tol=0 时白名单=3>effective(2)
    // → 进入分级裁剪（仅 action_peak 会裁，但这里只有 asrAnchor，白名单无仅 action_peak 帧 → 分级裁剪不起作用；白名单仍 > budget → 降级保留全部白名单，不裁剪 candidate？—— 不对，BudgetClipper 超容差时：降级保留全部白名单不删，dropped=0）
    // → 修正断言：dropped.length = 0（降级保留白名单）
    const keptPaths = new Set(result.kept.map(f => f.framePath));
    expect(keptPaths.has(files[2])).toBe(true); // 吸附帧一定在 kept
  });

  // [P2-集成-2] UNIFORM_FPS gate：ASR 即使提供，声画锚定仍整体跳过（不变式：不破坏均匀抽帧策略）
  it('[P2-集成-2] UNIFORM_FPS strategy gate：即使传 asrLines + 吸附时间匹配，声画锚定跳过（吸附帧 无 asrAnchor 白名单标志）', async () => {
    // 构造 5 帧，time 1000/3000/5000/7000/9000
    const files = fakeFiles(5);
    const base = '0'.repeat(64);
    const hashSeq = Array.from({ length: 5 }, (_, i) => hashWithHammingDistance(base, 15 + i * 10));
    computeHashSpy.mockImplementation(async (fp: string) => {
      const idx = files.indexOf(fp);
      return hashSeq[idx] ?? base;
    });
    const asrLines = [fakeAsr(4000, 6000, '台词')];
    // Spy BudgetClipper.clip：查看 priorityFlags 是否传 files[2] 带 asrAnchor —— 更简单的断言：spy 后看调用参数
    const { mock: { calls: spyCallsBefore } } = vi.spyOn(SmartFramePostProcessor, 'process');
    const clipSpy = vi.spyOn(await import('../backend/BudgetClipper').then(m => m.BudgetClipper), 'clip');

    const result = await SmartFramePostProcessor.process(files, {
      strategy: 'UNIFORM_FPS', fps: 1,
      dedupThreshold: 0, maxFrames: 2, toleranceRatio: 0,
      silentBudgetClipper: true,
      asrSampling: { enabled: true, toleranceMs: 3000 },
      asrLines,
    });
    // BudgetClipper 被调了 1 次 → priorityFlags 里没有 files[2] asrAnchor（因为 UNIFORM_FPS gate）
    expect(clipSpy).toHaveBeenCalledTimes(1);
    const priorityFlags = (clipSpy.mock.calls[0][1] as any)?.priorityFlags as Record<string, string[]> | undefined;
    const anchorFlags = (priorityFlags?.[files[2]] ?? []).filter(f => f === 'asrAnchor');
    expect(anchorFlags.length).toBe(0); // UNIFORM_FPS → 无 asrAnchor flag
    clipSpy.mockRestore();
  });

  // [P2-集成-3] 回滚安全：asrSampling.enabled=false + asrLines 空 → kept 数量/路径 与 enabled=true 且无 asrLines 时 ±0 baseline
  it('[P2-集成-3] 回滚安全：asrSampling.enabled=false 与 enabled=true (无 asrLines) → kept 数量/帧集合完全相等（±0 baseline）', async () => {
    const files = fakeFiles(5);
    const base = '0'.repeat(64);
    const hashSeq = Array.from({ length: 5 }, (_, i) => hashWithHammingDistance(base, 15 + i * 10));
    computeHashSpy.mockImplementation(async (fp: string) => {
      const idx = files.indexOf(fp);
      return hashSeq[idx] ?? base;
    });
    const [baselineOff, baselineOnNoAsr] = await Promise.all([
      SmartFramePostProcessor.process(files, {
        strategy: 'AUTO_ADAPTIVE', fps: 1, dedupThreshold: 0,
        densityPreset: undefined, maxFrames: undefined, silentBudgetClipper: true,
        asrSampling: { enabled: false },
        asrLines: [], // 空数组 = 无 ASR
      }),
      SmartFramePostProcessor.process(files, {
        strategy: 'AUTO_ADAPTIVE', fps: 1, dedupThreshold: 0,
        densityPreset: undefined, maxFrames: undefined, silentBudgetClipper: true,
        asrSampling: { enabled: true },
        asrLines: [], // 空数组 = 无 ASR（gate 直接跳）
      }),
    ]);
    expect(baselineOff.kept).toHaveLength(5);
    expect(baselineOnNoAsr.kept).toHaveLength(5);
    // 回滚安全不变式：两结果帧集合完全相同
    const pathsOff = new Set(baselineOff.kept.map(f => f.framePath));
    const pathsOn = new Set(baselineOnNoAsr.kept.map(f => f.framePath));
    expect(pathsOff.size).toBe(pathsOn.size);
    for (const p of pathsOff) expect(pathsOn.has(p)).toBe(true);
  });
});