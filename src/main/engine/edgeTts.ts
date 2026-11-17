// 📁 路径：src/main/engine/edgeTts.ts
// 微软官方 Edge TTS 免费接口实现（替代已失效的第三方代理 api.tts.quest）
// 零外部依赖：Node 内置 https + crypto 手写 RFC 6455 WebSocket 客户端，
// 因为 Node 原生 WebSocket 无法自定义请求头，而微软服务校验 Origin/User-Agent。
//
// 协议要点（已实测打通，参考 edge-tts 开源实现）：
//   1. 握手带 TrustedClientToken + 动态 Sec-MS-GEC（v2 签名，5 分钟时间窗）
//   2. 发送帧必须是带 Path 头的 Message 文本帧（speech.config / ssml）
//   3. 音频二进制消息 = [2B headerLen BE][header 文本 X-RequestId...Path:audio][MP3 数据直接开始]
//   4. 结束信号 = 文本帧 Path:turn.end
//   5. 签名版本号与 UA 的 Chromium 版本必须跟随 Edge 内核更新，否则握手直接 403
//      （2026-10 起微软把 Sec-MS-GEC 换成 v2，旧的纯 SHA256 签名一律被拒）

import crypto from 'crypto'
import https from 'https'
import type { Socket } from 'net'

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
// 签名版本前缀 2 = v2 算法；Chromium 版本需跟随 Edge 内核（2026-11 对应 143.0.3650.75）
const CHROMIUM_FULL_VERSION = '143.0.3650.75'
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split('.')[0]
const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'
const WSS_HOST = 'speech.platform.bing.com'
const WSS_PATH = '/consumer/speech/synthesize/readaloud/edge/v1'

// 微软服务校验的请求头（必须与 Edge 浏览器一致，否则握手被拒）
const WSS_HEADERS = {
  'Pragma': 'no-cache',
  'Cache-Control': 'no-cache',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  'Sec-WebSocket-Version': '13',
  'User-Agent':
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
}

// RFC 6455 握手魔数
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

// ── Sec-MS-GEC v2 签名 ───────────────────────────────────────────────────────
// 微软私有接口：v2 =「CS64 8 字节摘要 + 改造版 SHA-256」双摘要，输入是
// 「对齐到 5 分钟的 Windows 文件时间字符串 + TrustedClientToken」。
// 常量逐字对齐 edge-tts/src/edge_tts/drm.py —— 这不是标准 SHA-256，不能替换成 crypto 实现。
const U32_MASK_BIG = 0xffffffffn

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const
/** 改造版起始状态：替代标准 IV（words 0~13 被置零，等价于起始轮次从 14 开始） */
const SHA256_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2,
] as const
/** 前 14 个消息字由自定义常量代替（标准算法里它们来自输入的前 56 字节） */
const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6,
  0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33, 0xd258b060, 0x72766564,
] as const
const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const
/** 第 14 轮常量被替换（标准值 0x9bdc06a7 → 0xc9dc06a7） */
const SHA256_ADJUSTMENT = 0xc9dc06a7
const SHA256_BLOCK_CONSTANTS = SHA256_ROUND_CONSTANTS.map((value, index) =>
  index === 14 ? SHA256_ADJUSTMENT : value
)
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0

const CS64_COEFFICIENTS: ReadonlyArray<readonly [number, number]> = [
  [0xe82e91b1, 0xb32700d0],
  [0x44de24c6, 0x88dff51d],
  [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5],
  [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6],
  [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464],
  [0xbed20560, 0x3c3c74f3],
  [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1],
  [0xcb49e3c6, 0xc5626167],
]
const CS64_FACTOR = 0x82893933
const CS64_ADJUSTMENT0 = 0xf2f90b1a
const CS64_ADJUSTMENT1 = 0x0b1a0000

function rotr32(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0
}

function smallSigma0(value: number): number {
  return (rotr32(value, 7) ^ rotr32(value, 18) ^ (value >>> 3)) >>> 0
}

function smallSigma1(value: number): number {
  return (rotr32(value, 17) ^ rotr32(value, 19) ^ (value >>> 10)) >>> 0
}

/** 消息扩展：from 之前的下标由调用方填好 */
function expandSchedule(words: number[], from: number): void {
  for (let i = from; i < 64; i++) {
    words[i] = (smallSigma1(words[i - 2]) + words[i - 7] + smallSigma0(words[i - 15]) + words[i - 16]) >>> 0
  }
}

/** 压缩函数的 64 轮（可从中途开始，v2 从第 14 轮起跑） */
function runRounds(
  state: readonly number[],
  words: readonly number[],
  constants: readonly number[],
  firstRound: number
): number[] {
  let [a, b, c, d, e, f, g, h] = state
  for (let i = firstRound; i < 64; i++) {
    const s1 = (rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)) >>> 0
    const ch = ((e & f) ^ (~e & g)) >>> 0
    const t1 = (h + s1 + ch + constants[i] + words[i]) >>> 0
    const s0 = (rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)) >>> 0
    const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
    const t2 = (s0 + maj) >>> 0
    h = g
    g = f
    f = e
    e = (d + t1) >>> 0
    d = c
    c = b
    b = a
    a = (t1 + t2) >>> 0
  }
  return [a, b, c, d, e, f, g, h]
}

/** 改造版初始状态：前 7 个字节进消息字，其余由自定义常量与调整值填充 */
function sha256Init(prefix: Buffer): number[] {
  const words: number[] = new Array(64).fill(0)
  words[14] = prefix.readUIntBE(0, 3)
  words[15] = prefix.readUIntBE(3, 4)
  for (let i = 16; i < 30; i++) {
    let value = SHA256_SCHEDULE[i - 16]
    value += i === 16 ? smallSigma1(words[14]) ^ SHA256_SIGMA1_ADJUSTMENT : smallSigma1(words[i - 2])
    if (i >= 21) value += words[i - 7]
    if (i === 29) value += smallSigma0(words[14]) ^ SHA256_SIGMA0_ADJUSTMENT
    words[i] = value >>> 0
  }
  words[30] =
    (smallSigma1(words[28]) +
      words[23] +
      smallSigma0(words[15]) +
      words[14] +
      SHA256_ADJUSTMENT -
      SHA256_ROUND_CONSTANTS[14]) >>>
    0
  expandSchedule(words, 31)
  const working = runRounds(SHA256_STATE, words, SHA256_BLOCK_CONSTANTS, 14)
  return SHA256_INITIAL.map((value, index) => (value + working[index]) >>> 0)
}

/** 改造版摘要：前 7 字节走自定义初始状态，其余按自定义填充规则喂入 */
function sha256Digest(data: Buffer): Buffer {
  if (data.length < 7) throw new Error('Sec-MS-GEC 输入至少 7 字节')
  const messageLength = 57 + data.length
  const padLength = (((55 - messageLength) % 64) + 64) % 64
  const lengthField = Buffer.alloc(8)
  lengthField.writeBigUInt64BE(BigInt(messageLength * 8))
  const padded = Buffer.concat([data.subarray(7), Buffer.from([0x80]), Buffer.alloc(padLength), lengthField])

  let state = sha256Init(data.subarray(0, 7))
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words: number[] = []
    for (let i = 0; i < 16; i++) words.push(padded.readUInt32BE(offset + i * 4))
    expandSchedule(words, 16)
    const working = runRounds(state, words, SHA256_ROUND_CONSTANTS, 0)
    state = state.map((value, index) => (value + working[index]) >>> 0)
  }

  const digest = Buffer.alloc(32)
  state.forEach((value, index) => digest.writeUInt32BE(value, index * 4))
  return digest
}

function rol16(value: bigint): bigint {
  return ((value << 16n) | (value >> 16n)) & U32_MASK_BIG
}

/** CS64 摘要：以摘要前 8 字节为密钥的 32 位混合函数，返回两个 32 位分量 */
function cs64Digest(data: Buffer, digest: Buffer): [number, number] {
  const keyA = BigInt((digest.readUInt32LE(0) | 1) >>> 0)
  const keyB = BigInt((digest.readUInt32LE(4) | 1) >>> 0)
  const factors = [
    (keyA * BigInt(CS64_FACTOR)) & U32_MASK_BIG,
    (keyB * BigInt(CS64_FACTOR)) & U32_MASK_BIG,
  ]
  const terms: bigint[] = CS64_COEFFICIENTS.map(
    ([coefficient], index) => (BigInt(coefficient) * factors[index % 2]) & U32_MASK_BIG
  )
  const offsets: bigint[] = CS64_COEFFICIENTS.map(([, offset]) => BigInt(offset))

  // 输入 = 0x00 前缀 + 完整哈希原文，按 4 字节小端切词（词数为奇数时补 0）
  const raw = Buffer.concat([Buffer.from([0]), data])
  const words: number[] = []
  for (let offset = 0; offset < raw.length; offset += 4) {
    const chunk = Buffer.alloc(4)
    raw.copy(chunk, 0, offset, Math.min(offset + 4, raw.length))
    words.push(chunk.readUInt32LE(0))
  }
  if (words.length % 2 === 1) words.push(0)

  words.forEach((word, index) => {
    const value = BigInt(word)
    let term = value * (index % 2 === 0 ? keyA : keyB)
    let offset = rol16(value) * (index % 2 === 0 ? 0xef0569fbn : 0xc31713dbn)
    if (index === 0) {
      term += BigInt(CS64_ADJUSTMENT0) * factors[0]
      offset += BigInt(CS64_ADJUSTMENT1)
    }
    terms.push(term & U32_MASK_BIG)
    offsets.push(offset & U32_MASK_BIG)
  })

  let swapAcc = 0n
  let swapLast = 0n
  let state = 0n
  let acc = 0n
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i]
    const y = terms[i + 1]

    let t = rol16((offsets[i] + x) & U32_MASK_BIG)
    let q = (t * 0x76f50f34n) & U32_MASK_BIG
    swapAcc = (swapAcc + ((rol16(q) * 0xc3efea97n + q) & U32_MASK_BIG)) & U32_MASK_BIG

    t = rol16((offsets[i + 1] + y) & U32_MASK_BIG)
    q = (t * 0x1881ce3cn) & U32_MASK_BIG
    swapLast = (rol16(q) * 0x35bd1ec9n + q) & U32_MASK_BIG
    swapAcc = (swapAcc + swapLast) & U32_MASK_BIG

    state = (state * keyA + x) & U32_MASK_BIG
    state = (rol16(state) * 0xcf98b111n) & U32_MASK_BIG
    state = (rol16(state) * 0x87085b9fn) & U32_MASK_BIG
    state = (rol16(state) * 0x12ceb96dn) & U32_MASK_BIG
    state = (rol16(state) * 0x257e1d83n) & U32_MASK_BIG
    acc = (acc + state) & U32_MASK_BIG

    t = (state * keyB + y) & U32_MASK_BIG
    t = (rol16(t) * 0xa27416f5n) & U32_MASK_BIG
    t = (rol16(t) * 0xd38396ffn) & U32_MASK_BIG
    state = (rol16((rol16(t) * 0x7c932b89n) & U32_MASK_BIG) * 0xbfa49f69n) & U32_MASK_BIG
    acc = (acc + state) & U32_MASK_BIG
  }

  return [
    Number((swapLast ^ state) & U32_MASK_BIG),
    Number((swapAcc ^ acc) & U32_MASK_BIG),
  ]
}

/**
 * 计算 Sec-MS-GEC 动态令牌（v2）：5 分钟时间窗对齐的 Windows 文件时间 + 双摘要
 * 输出格式 `<CS64 16 位 hex>-<SHA256 64 位 hex>`（大写）
 */
export function computeSecMsGec(date: Date = new Date()): string {
  const seconds = date.getTime() / 1000 + 11644473600
  const ticks = (seconds - (seconds % 300)) * 1e7
  const input = Buffer.from(`${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`, 'ascii')
  const digest = sha256Digest(input)
  const [high, low] = cs64Digest(input, digest)
  const cs64 = Buffer.alloc(8)
  cs64.writeUInt32LE(high, 0)
  cs64.writeUInt32LE(low, 4)
  return `${cs64.toString('hex').toUpperCase()}-${digest.toString('hex').toUpperCase()}`
}

/** 转义 SSML 特殊字符，防止注入/破坏 XML 结构 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 构建 edge-tts 的 Message 文本帧：带 Path 头标识帧类型（speech.config / ssml / ...）
 */
function buildEdgeMessage(requestId: string, timestamp: string, path: string, contentType: string, data: string): string {
  return (
    `X-RequestId:${requestId}\r\n` +
    `Content-Type:${contentType}\r\n` +
    `X-Timestamp:${timestamp}\r\n` +
    `Path:${path}\r\n\r\n` +
    data
  )
}

/** 握手被服务端拒绝（未返回 101）：通常意味着微软轮换了签名算法或版本号 */
export class EdgeTtsHandshakeRejectedError extends Error {
  constructor(public readonly httpStatus: number) {
    super(
      `微软 Edge TTS 握手被拒绝（HTTP ${httpStatus}）：签名校验规则可能已随 Edge 内核更新，` +
        `需要更新客户端签名版本后才能继续使用`
    )
    this.name = 'EdgeTtsHandshakeRejectedError'
  }
}

interface WssCallbacks {
  onOpen: (sendText: (text: string) => void) => void
  onText: (text: string) => void
  onBinary: (buf: Buffer) => void
  onError: (err: Error) => void
  onClose: () => void
}

/** WebSocket 帧 opcode */
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

/**
 * 客户端发送一个 WebSocket 帧（带掩码，RFC 6455 客户端必须掩码）
 */
function sendFrame(socket: Socket, opcode: number, payload: Buffer): void {
  const mask = crypto.randomBytes(4)
  const masked = Buffer.alloc(payload.length)
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4]

  const len = payload.length
  const header: number[] = [0x80 | opcode] // FIN=1
  if (len < 126) {
    header.push(0x80 | len) // MASK=1
  } else if (len < 65536) {
    header.push(0x80 | 126, (len >> 8) & 0xff, len & 0xff)
  } else {
    const big = Buffer.alloc(8)
    big.writeBigUInt64BE(BigInt(len))
    header.push(0x80 | 127, ...big)
  }
  socket.write(Buffer.concat([Buffer.from(header), mask, masked]))
}

/**
 * 极简 WSS 客户端（RFC 6455 客户端实现）：
 * 通过 https.request 发起 Upgrade，101 后接管 socket 解析服务端帧。
 * 返回关闭函数。握手成功后触发 onOpen（可在其中发送消息）。
 */
function wssConnect(url: string, headers: Record<string, string>, callbacks: WssCallbacks): () => void {
  const parsed = new URL(url)
  const secKey = crypto.randomBytes(16).toString('base64')
  let closed = false
  let socketRef: Socket | null = null
  let receiveBuffer = Buffer.alloc(0)

  const close = (): void => {
    if (closed) return
    closed = true
    try {
      socketRef?.destroy()
    } catch {
      /* 忽略 */
    }
  }

  const req = https.request({
    hostname: parsed.hostname,
    port: Number(parsed.port) || 443,
    path: parsed.pathname + parsed.search,
    headers: {
      Host: parsed.host,
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': secKey,
      ...headers,
    },
  })

  req.on('upgrade', (res, socket, head) => {
    // 校验握手响应
    const expectedAccept = crypto.createHash('sha1').update(secKey + WS_GUID).digest('base64')
    const actualAccept = String(res.headers['sec-websocket-accept'] || '')
    if (actualAccept !== expectedAccept) {
      callbacks.onError(new Error(`微软 Edge TTS 握手校验失败 (Sec-WebSocket-Accept 不匹配)`))
      socket.destroy()
      return
    }
    socketRef = socket
    if (head && head.length > 0) receiveBuffer = Buffer.concat([receiveBuffer, head])

    // 通知调用方连接就绪，可发送配置帧/SSML 帧
    callbacks.onOpen((text: string) => sendFrame(socket, OP_TEXT, Buffer.from(text)))

    socket.on('data', (chunk: Buffer) => {
      receiveBuffer = Buffer.concat([receiveBuffer, chunk])
      // 循环解析完整帧
      for (;;) {
        const frame = tryParseFrame(receiveBuffer)
        if (!frame) break
        receiveBuffer = receiveBuffer.subarray(frame.consumed)
        const { opcode, payload } = frame
        if (opcode === OP_TEXT) {
          callbacks.onText(payload.toString('utf8'))
        } else if (opcode === OP_BINARY) {
          callbacks.onBinary(payload)
        } else if (opcode === OP_PING) {
          sendFrame(socket, OP_PONG, payload)
        } else if (opcode === OP_CLOSE) {
          callbacks.onClose()
          socket.end()
          return
        }
        // OP_PONG 忽略
      }
    })
    socket.on('error', (err) => callbacks.onError(err))
    socket.on('close', () => callbacks.onClose())
  })

  req.on('response', (res) => {
    // 服务端没有升级成 WebSocket：握手被拒（典型 403 —— 签名算法/版本号已过期）
    res.resume()
    callbacks.onError(new EdgeTtsHandshakeRejectedError(res.statusCode ?? 0))
    req.destroy()
  })

  req.on('error', (err) => callbacks.onError(err))
  req.end()

  return close
}

interface ParsedFrame {
  opcode: number
  payload: Buffer
  consumed: number
}

/**
 * 尝试从缓冲区解析一帧 WebSocket 消息；数据不足返回 null
 * 服务端帧无掩码（RFC 6455 规定）
 */
function tryParseFrame(buffer: Buffer): ParsedFrame | null {
  if (buffer.length < 2) return null
  const b0 = buffer[0]
  const b1 = buffer[1]
  const opcode = b0 & 0x0f
  let len = b1 & 0x7f
  let offset = 2
  if (len === 126) {
    if (buffer.length < 4) return null
    len = buffer.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    if (buffer.length < 10) return null
    const big = buffer.readBigUInt64BE(2)
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null
    len = Number(big)
    offset = 10
  }
  if (buffer.length < offset + len) return null
  return {
    opcode,
    payload: buffer.subarray(offset, offset + len),
    consumed: offset + len,
  }
}

export interface EdgeTtsOptions {
  text: string
  voice: string // 如 zh-CN-XiaoxiaoNeural / en-US-JennyNeural
  rate?: number // 语速倍率 0.5~2.0，默认 1.0，映射为 SSML rate 百分比
  pitchHz?: number // 音高偏移（Hz，整数，通常 -4~+4），默认 0，映射为 SSML prosody pitch
  timeoutMs?: number // 请求超时，默认 30s
}

/**
 * 调用微软官方 Edge TTS（免费、无需 key），返回 mp3 音频 Buffer
 * 错误直接抛出（连接失败 / 超时 / 空音频），由调用方 fallback 链处理
 */
export function synthesizeEdgeTts(opts: EdgeTtsOptions): Promise<Buffer> {
  const { text, voice, rate = 1.0, pitchHz = 0, timeoutMs = 30000 } = opts
  if (!text.trim()) return Promise.reject(new Error('Edge TTS 合成文本不能为空'))

  // 语速倍率 → SSML rate 百分比（如 1.3 → +30%，0.8 → -20%）
  const ratePercent = Math.round((rate - 1) * 100)
  const rateStr = ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`

  // 音高偏移 → SSML prosody pitch（以 Hz 为单位；0 → +0Hz 保持原有中性行为）
  const pitchValue = Math.round(pitchHz)
  const pitchStr = `${pitchValue >= 0 ? '+' : ''}${pitchValue}Hz`

  // 句尾停顿不在 SSML 里做：微软会直接掐断带 <break>/mstts:silence 的会话（实测 turn.start 后即关闭），
  // 改由 step4 的 AudioProcessor.trimAudioEdges(tailPadMs) 在音频层补静音

  const url =
    `wss://${WSS_HOST}${WSS_PATH}` +
    `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${computeSecMsGec()}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
    `&ConnectionId=${crypto.randomUUID()}`

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let settled = false

    const fail = (msg: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      close()
      reject(new Error(msg))
    }

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      close()
      const audio = Buffer.concat(chunks)
      if (audio.length === 0) {
        reject(new Error('微软 Edge TTS 未返回音频数据'))
      } else {
        resolve(audio)
      }
    }

    const timer = setTimeout(() => fail('微软 Edge TTS 请求超时'), timeoutMs)

    // 预构建配置帧与 SSML 帧（带 Path 头的 Message 文本帧）
    const requestId = crypto.randomUUID()
    const timestamp = new Date().toUTCString().replace('GMT', 'GMT+0000')
    const configMsg = buildEdgeMessage(
      requestId,
      timestamp,
      'speech.config',
      'application/json',
      JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
              outputFormat: OUTPUT_FORMAT,
            },
          },
        },
      })
    )
    const ssmlMsg = buildEdgeMessage(
      requestId,
      timestamp,
      'ssml',
      'application/ssml+xml',
      `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>` +
        `<voice name='${voice}'><prosody pitch='${pitchStr}' rate='${rateStr}' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`
    )

    // 连接与帧收发
    const close = wssConnect(url, WSS_HEADERS, {
      onOpen: (sendText) => {
        sendText(configMsg)
        sendText(ssmlMsg)
      },
      onText: (text) => {
        // 文本元数据帧，含 Path:turn.end 表示本次合成会话结束
        if (text.includes('Path:turn.end')) finish()
      },
      onBinary: (buf) => {
        // 音频二进制消息 = [2B headerLen BE][header 文本 X-RequestId...Path:audio][MP3 数据直接开始]
        if (buf.length < 4) return
        const headerLen = buf.readUInt16BE(0)
        const audioStart = 2 + headerLen
        if (audioStart > buf.length) return
        chunks.push(buf.subarray(audioStart))
      },
      onError: (err) => fail(`微软 Edge TTS 连接失败: ${err.message}`),
      onClose: () => {
        // 正常结束由 finish 处理；异常提前关闭时报错暴露
        if (!settled) fail('微软 Edge TTS 连接提前关闭')
      },
    })
  })
}
