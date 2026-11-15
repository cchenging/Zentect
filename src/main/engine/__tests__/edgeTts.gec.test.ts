// Module: main/engine - Edge TTS Sec-MS-GEC v2 签名与连通性测试

import { describe, expect, it } from 'vitest'
import { computeSecMsGec, synthesizeEdgeTts } from '../edgeTts'

/**
 * 参考向量：由官方 edge-tts 7.3.1 的 drm.generate_sec_ms_gec_v2(ts) 生成。
 * 固定时间戳保证离线可复现；算法一旦被我们改错，这里会立刻失败。
 */
const VECTORS: ReadonlyArray<readonly [number, string]> = [
  [
    946684800,
    '41A43A492D549652-24643F6BF1CF643EF8271B970DB1E914BE86F0C606C9A8699B3F8D086CBEC87A',
  ],
  [
    1763200000,
    'D3FE64A6A27FCCFA-D2F4E1ED43481E029BF5565B34083B638EC95540E698264C0C9F9195B2BA5444',
  ],
  [
    1794738461,
    'CAE9C10743608C0A-3A9F851DFC358F9EB04E61F0D24DEFF13D9B591E0B796C76B33FB5E67D1FE30C',
  ],
  [
    1794742200,
    '31D87D1F04002DBD-D9F5A8D9E8C7328A4D2A35E8831D14DE0DC51044ACBB2B18E7B8378A395AE00F',
  ],
]

describe('computeSecMsGec', () => {
  it.each(VECTORS)('时间戳 %i 应生成与官方 edge-tts 一致的 v2 令牌', (timestamp, expected) => {
    expect(computeSecMsGec(new Date(timestamp * 1000))).toBe(expected)
  })

  it('令牌格式应为 16 位 CS64 + 连字符 + 64 位 SHA256（大写 hex）', () => {
    expect(computeSecMsGec(new Date(1794738461 * 1000))).toMatch(/^[0-9A-F]{16}-[0-9A-F]{64}$/)
  })

  it('同一 5 分钟窗口内令牌相同，跨越窗口边界后变化', () => {
    const base = 1794738461 * 1000
    expect(computeSecMsGec(new Date(base))).toBe(computeSecMsGec(new Date(base + 60_000)))
    expect(computeSecMsGec(new Date(base))).not.toBe(computeSecMsGec(new Date(base + 300_000)))
  })
})

// 真实网络校验：默认跳过，仅手动执行 `ZENTECT_EDGE_TTS_LIVE=1 npx vitest run src/main/engine`
const liveIt = process.env.ZENTECT_EDGE_TTS_LIVE ? it : it.skip

describe('synthesizeEdgeTts', () => {
  liveIt(
    '应能完成握手并返回音频（含东北女声）',
    async () => {
      const audio = await synthesizeEdgeTts({
        text: '这是一次连通性测试。',
        voice: 'zh-CN-liaoning-XiaobeiNeural',
      })
      expect(audio.length).toBeGreaterThan(2000)
    },
    30_000
  )
})
