/* ============================================================
   StardustDrawer — 十字星芒
   中心亮点 + 四向光线（四角星），闪烁
   ============================================================ */

import type { ShapeDrawer } from '../types'

export const stardustDrawer: ShapeDrawer = {
  draw(ctx, p, _preset, opacity) {
    if (opacity <= 0) return
    const size = p.size
    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.rotate(p.rotation)

    // 十字光线
    ctx.strokeStyle = p.color.replace('VAR', (opacity * 0.8).toFixed(4))
    ctx.lineWidth = size * 0.3
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(-size * 2, 0); ctx.lineTo(size * 2, 0)
    ctx.moveTo(0, -size * 2); ctx.lineTo(0, size * 2)
    ctx.stroke()

    // 中心亮点
    ctx.beginPath()
    ctx.arc(0, 0, size * 0.5, 0, Math.PI * 2)
    ctx.fillStyle = p.color.replace('VAR', opacity.toFixed(4))
    ctx.fill()
    ctx.restore()
  },
}
