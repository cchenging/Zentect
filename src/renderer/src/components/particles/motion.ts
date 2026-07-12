/* ============================================================
   MotionEngine — 共享运动学
   管理粒子位置更新 / 横向摆动 / 生命周期 / 越界重生 / 旋转
   与形态无关，全部预设复用，避免每个形态重复运动代码
   ============================================================ */

import type { ParticlePreset, Particle, MotionEngine } from './types'

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
    case 'bottom-up': return y < -20 || x < -20 || x > w + 20
    case 'top-down':  return y > h + 20 || x < -20 || x > w + 20
    case 'random':    return x < -20 || x > w + 20 || y < -20 || y > h + 20
    default:          return false
  }
}

function spawnY(h: number, respawn: ParticlePreset['respawn']): number {
  switch (respawn) {
    case 'bottom-up': return h + 20
    case 'top-down':  return -20
    case 'random':    return Math.random() * h
    default:          return h + 20
  }
}

function createParticle(
  w: number, h: number,
  preset: ParticlePreset,
  colors: string[],
  fromRespawn: boolean,
): Particle {
  return {
    x: Math.random() * w,
    y: fromRespawn ? spawnY(h, preset.respawn) : Math.random() * h,
    vx: rand(preset.vxRange[0], preset.vxRange[1]),
    vy: rand(preset.vyRange[0], preset.vyRange[1]),
    size: rand(preset.sizeRange[0], preset.sizeRange[1]),
    opacity: rand(preset.opacityRange[0], preset.opacityRange[1]),
    life: 0,
    maxLife: rand(preset.lifeRange[0], preset.lifeRange[1]),
    color: pickColor(colors),
    twinklePhase: rand(0, Math.PI * 2),
    rotation: rand(0, Math.PI * 2),
    rotationSpeed: rand(-0.02, 0.02),
  }
}

const init: MotionEngine['init'] = (w, h, preset, colors) => {
  const ps: Particle[] = []
  for (let i = 0; i < preset.count; i++) {
    ps.push(createParticle(w, h, preset, colors, false))
  }
  return ps
}

const update: MotionEngine['update'] = (p, w, h, preset, colors) => {
  p.x += p.vx + Math.sin(p.life * 0.02) * preset.drift
  p.y += p.vy
  p.life++
  p.rotation += p.rotationSpeed
  if (preset.twinkle) p.twinklePhase += 0.06

  if (p.life >= p.maxLife || isOffscreen(p.x, p.y, w, h, preset.respawn)) {
    Object.assign(p, createParticle(w, h, preset, colors, true))
  }
}

export const motionEngine: MotionEngine = { init, update }
