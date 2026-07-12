/* ============================================================
   SnowDrawer — 六角雪花
   6 瓣对称 + 小分支，向下落 + 轻摆
   ============================================================ */

import type { ShapeDrawer } from '../types'

export const snowDrawer: ShapeDrawer = {
  draw(ctx, p, _preset, opacity) {
    if (opacity <= 0) return
    const size = p.size
    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.rotate(p.rotation)
    ctx.strokeStyle = p.color.replace('VAR', opacity.toFixed(4))
    ctx.lineWidth = 0.6
    ctx.lineCap = 'round'

    for (let i = 0; i < 6; i++) {
      ctx.rotate(Math.PI / 3)
      ctx.beginPath()
      // 主瓣
      ctx.moveTo(0, 0)
      ctx.lineTo(size, 0)
      // 小分支
      ctx.moveTo(size * 0.55, 0)
      ctx.lineTo(size * 0.75, size * 0.25)
      ctx.moveTo(size * 0.55, 0)
      ctx.lineTo(size * 0.75, -size * 0.25)
      ctx.stroke()
    }
    ctx.restore()
  },
}
