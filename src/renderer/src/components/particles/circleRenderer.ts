/* ============================================================
   CircleRenderer — 圆点粒子渲染器
   覆盖一期全部预设（dandelion / stardust / dust / snow / firefly）
   无状态纯函数；差异由 preset 参数控制
   ============================================================ */

import type { ParticlePreset, CircleParticle, ParticleRenderer } from './types'

// ──────────── 工具 ────────────

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a)
}

function pickColor(colors: string[]): string {
  return colors[Math.floor(Math.random() * colors.length)] || colors[0]
}

function isOffscreen(
  x: number, y: number,
  w: number, h: number,
  respawn: ParticlePreset['respawn'],
): boolean {
  switch (respawn) {
    case 'bottom-up':
      return y < -20 || x < -20 || x > w + 20
    case 'top-down':
      return y > h + 20 || x < -20 || x > w + 20
    case 'random':
      return x < -20 || x > w + 20 || y < -20 || y > h + 20
    default:
      return false
  }
}

function spawnY(h: number, respawn: ParticlePreset['respawn']): number {
  switch (respawn) {
    case 'bottom-up':   return h + 20
    case 'top-down':    return -20
    case 'random':      return Math.random() * h
    default:            return h + 20
  }
}

// ──────────── 创建单粒子 ────────────

function createParticle(
  w: number,
  h: number,
  preset: ParticlePreset,
  colors: string[],
  fromRespawn: boolean,
): CircleParticle {
  return {
    x: Math.random() * w,
    y: fromRespawn ? spawnY(h, preset.respawn) : Math.random() * h,
    vx: rand(preset.vxRange[0], preset.vxRange[1]),
    vy: rand(preset.vyRange[0], preset.vyRange[1]),
    radius: rand(preset.sizeRange[0], preset.sizeRange[1]),
    opacity: rand(preset.opacityRange[0], preset.opacityRange[1]),
    life: 0,
    maxLife: rand(preset.lifeRange[0], preset.lifeRange[1]),
    color: pickColor(colors),
    twinklePhase: rand(0, Math.PI * 2),
  }
}

// ──────────── Renderer 接口实现 ────────────

function init(
  w: number,
  h: number,
  preset: ParticlePreset,
  colors: string[],
): CircleParticle[] {
  const ps: CircleParticle[] = []
  for (let i = 0; i < preset.count; i++) {
    ps.push(createParticle(w, h, preset, colors, false))
  }
  return ps
}

function update(
  p: CircleParticle,
  w: number,
  h: number,
  preset: ParticlePreset,
  colors: string[],
): void {
  p.x += p.vx + Math.sin(p.life * 0.02) * preset.drift
  p.y += p.vy
  p.life++

  if (preset.twinkle) {
    p.twinklePhase += 0.06
  }

  if (p.life >= p.maxLife || isOffscreen(p.x, p.y, w, h, preset.respawn)) {
    const fresh = createParticle(w, h, preset, colors, true)
    Object.assign(p, fresh)
  }
}

function draw(
  ctx: CanvasRenderingContext2D,
  p: CircleParticle,
  _preset: ParticlePreset,
): void {
  const lifeRatio = p.life / p.maxLife
  let op = p.opacity * (1 - lifeRatio) * (lifeRatio < 0.1 ? lifeRatio * 10 : 1)

  if (_preset.twinkle) {
    op *= 0.5 + 0.5 * Math.sin(p.twinklePhase)
  }

  if (op <= 0) return

  ctx.beginPath()
  ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2)
  ctx.fillStyle = p.color.replace('VAR', op.toFixed(4))
  ctx.fill()
}

export const circleRenderer: ParticleRenderer = { init, update, draw }
