/* ============================================================
   形态绘制器路由表
   按 preset.shape 路由到对应 ShapeDrawer
   ============================================================ */

import type { ParticleShape, ShapeDrawer } from '../types'
import { dandelionDrawer } from './dandelion'
import { stardustDrawer } from './stardust'
import { dustDrawer } from './dust'
import { snowDrawer } from './snow'
import { fireflyDrawer } from './firefly'

export const shapeDrawers: Record<Exclude<ParticleShape, 'none'>, ShapeDrawer> = {
  dandelion: dandelionDrawer,
  stardust: stardustDrawer,
  dust: dustDrawer,
  snow: snowDrawer,
  firefly: fireflyDrawer,
}

export { dandelionDrawer, stardustDrawer, dustDrawer, snowDrawer, fireflyDrawer }
