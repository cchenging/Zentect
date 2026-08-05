// 📁 路径：src/main/engine/edgeTts.ts
// 微软官方 Edge TTS 免费接口实现（替代已失效的第三方代理 api.tts.quest）
// 零外部依赖：Node 内置 https + crypto 手写 RFC 6455 WebSocket 客户端，
// 因为 Node 原生 WebSocket 无法自定义请求头，而微软服务校验 Origin/User-Agent。
//
// 协议要点（已实测打通，参考 edge-tts 开源实现）：
//   1. 握手带 TrustedClientToken + 动态 Sec-MS-GEC（5 分钟时间窗哈希）
//   2. 发送帧必须是带 Path 头的 Message 文本帧（speech.config / ssml）
//   3. 音频二进制消息 = [2B headerLen BE][header 文本 X-RequestId...Path:audio][MP3 数据直接开始]
//   4. 结束信号 = 文本帧 Path:turn.end
//   5. 版本号/UA 必须保持较新（旧版 Chrome/130 会被 403 拒绝，需用 143）

import crypto from 'crypto'
import https from 'https'
import type { Socket } from 'net'

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
// 微软要求较新的 Chromium 版本号（旧版本会被 403 拒绝）
const SEC_MS_GEC_VERSION = '1-143.0.3650.75'
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
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
}

// RFC 6455 握手魔数
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/**
 * 计算 Sec-MS-GEC 动态令牌：5 分钟时间窗取整 + token 哈希（微软要求，防止伪造请求）
 */
function computeSecMsGec(date: Date = new Date()): string {
  const ticks = 116444736000000000 + date.getTime() * 10000
  const roundedTicks = ticks - (ticks % 3000000000)
  const hash = crypto.createHash('sha256').update(`${roundedTicks}${TRUSTED_CLIENT_TOKEN}`).digest('hex')
  return hash.toUpperCase()
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
  timeoutMs?: number // 请求超时，默认 30s
}

/**
 * 调用微软官方 Edge TTS（免费、无需 key），返回 mp3 音频 Buffer
 * 错误直接抛出（连接失败 / 超时 / 空音频），由调用方 fallback 链处理
 */
export function synthesizeEdgeTts(opts: EdgeTtsOptions): Promise<Buffer> {
  const { text, voice, rate = 1.0, timeoutMs = 30000 } = opts
  if (!text.trim()) return Promise.reject(new Error('Edge TTS 合成文本不能为空'))

  // 语速倍率 → SSML rate 百分比（如 1.3 → +30%，0.8 → -20%）
  const ratePercent = Math.round((rate - 1) * 100)
  const rateStr = ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`

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
        `<voice name='${voice}'><prosody pitch='+0Hz' rate='${rateStr}' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`
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
