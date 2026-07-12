/* ============================================================
   DandelionDrawer — 蒲公英绒毛种子
   中心实心圆 + 8 根放射细线 + shadowBlur 柔光
   ============================================================ */

import type { ShapeDrawer } from '../types'

export const dandelionDrawer: ShapeDrawer = {
  draw(ctx, p, _preset, opacity) {
    if (opacity <= 0) return
    const size = p.size
    ctx.save()
    ctx.shadowBlur = size * 2
    ctx.shadowColor = p.color.replace('VAR', (opacity * 0.5).toFixed(4))

    // 放射绒毛细线
    const lines = 8
    ctx.strokeStyle = p.color.replace('VAR', (opacity * 0.6).toFixed(4))
    ctx.lineWidth = 0.5
    for (let i = 0; i < lines; i++) {
      const angle = (i / lines) * Math.PI * 2 + p.rotation
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
      ctx.lineTo(p.x + Math.cos(angle) * size * 1.8, p.y + Math.sin(angle) * size * 1.8)
      ctx.stroke()
    }

    // 中心实心圆
    ctx.beginPath()
    ctx.arc(p.x, p.y, size * 0.6, 0, Math.PI * 2)
    ctx.fillStyle = p.color.replace('VAR', opacity.toFixed(4))
    ctx.fill()
    ctx.restore()
  },
}
