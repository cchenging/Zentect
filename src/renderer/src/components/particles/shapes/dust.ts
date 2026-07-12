/* ============================================================
   DustDrawer — 微尘方块颗粒
   细小方块（1-2px），低透明度，极缓漂浮
   ============================================================ */

import type { ShapeDrawer } from '../types'

export const dustDrawer: ShapeDrawer = {
  draw(ctx, p, _preset, opacity) {
    if (opacity <= 0) return
    const s = p.size
    ctx.fillStyle = p.color.replace('VAR', opacity.toFixed(4))
    ctx.fillRect(p.x - s, p.y - s, s * 2, s * 2)
  },
}
