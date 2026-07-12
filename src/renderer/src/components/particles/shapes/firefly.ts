/* ============================================================
   FireflyDrawer — 萤火径向光晕
   radial gradient 亮中心渐隐，呼吸式明暗
   ============================================================ */

import type { ShapeDrawer } from '../types'

/** 从 "rgba(R,G,B,VAR)" 模板提取 R,G,B */
function extractRgb(template: string): [number, number, number] {
  const m = template.match(/rgba?\((\d+),(\d+),(\d+)/)
  return m ? [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])] : [255, 255, 255]
}

export const fireflyDrawer: ShapeDrawer = {
  draw(ctx, p, _preset, opacity) {
    if (opacity <= 0) return
    const size = p.size
    const [r, g, b] = extractRgb(p.color)
    const radius = size * 3
    const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius)
    gradient.addColorStop(0, `rgba(${r},${g},${b},${opacity.toFixed(4)})`)
    gradient.addColorStop(0.4, `rgba(${r},${g},${b},${(opacity * 0.4).toFixed(4)})`)
    gradient.addColorStop(1, `rgba(${r},${g},${b},0)`)
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2)
    ctx.fill()
  },
}
