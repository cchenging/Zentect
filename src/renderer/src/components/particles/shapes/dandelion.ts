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
    // 柔光晕：半径足够大才能看出"绒毛感"
    ctx.shadowBlur = size * 3
    ctx.shadowColor = p.color.replace('VAR', (opacity * 0.5).toFixed(4))

    // 放射绒毛细线 —— 伞状骨架，长度需明显大于中心圆才能辨出形态
    const lines = 8
    const lineLen = size * 3
    ctx.strokeStyle = p.color.replace('VAR', (opacity * 0.75).toFixed(4))
    ctx.lineWidth = 0.8
    ctx.lineCap = 'round'
    for (let i = 0; i < lines; i++) {
      const angle = (i / lines) * Math.PI * 2 + p.rotation
      const ex = p.x + Math.cos(angle) * lineLen
      const ey = p.y + Math.sin(angle) * lineLen
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
      ctx.lineTo(ex, ey)
      ctx.stroke()
      // 绒毛末端小点 —— 强化蒲公英种子质感
      ctx.beginPath()
      ctx.arc(ex, ey, 0.6, 0, Math.PI * 2)
      ctx.fillStyle = p.color.replace('VAR', (opacity * 0.5).toFixed(4))
      ctx.fill()
    }

    // 中心实心圆（种子核）
    ctx.beginPath()
    ctx.arc(p.x, p.y, size * 0.6, 0, Math.PI * 2)
    ctx.fillStyle = p.color.replace('VAR', opacity.toFixed(4))
    ctx.fill()
    ctx.restore()
  },
}
