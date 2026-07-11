/* ============================================================
   粒子系统共享类型
   ============================================================ */

/** 预设定义（驱动参数化粒子行为） */
export interface ParticlePreset {
  id: string
  name: string
  count: number
  /** CSS 变量名列表，运行时 getComputedStyle 解析 */
  colorTokens: string[]
  sizeRange: [number, number]
  opacityRange: [number, number]
  vxRange: [number, number]
  vyRange: [number, number]
  /** 横向正弦摆动系数 */
  drift: number
  lifeRange: [number, number]
  /** 重生方向 */
  respawn: 'bottom-up' | 'top-down' | 'random'
  /** 是否闪烁（星尘/萤火） */
  twinkle?: boolean
  /** 浅色模式下降级参数 */
  lightMode?: { countScale: number; opacityScale: number }
}

/** 粒子实例（CircleRenderer 用） */
export interface CircleParticle {
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  opacity: number
  life: number
  maxLife: number
  /** 预解析颜色模板 "rgba(R,G,B,VAR)"，用 VAR 占位帧级透明度 */
  color: string
  twinklePhase: number
}

/** 预设 ID 联合类型 */
export type ParticlePresetId = string

/** Renderer 接口：一组纯函数，无状态 */
export interface ParticleRenderer {
  init(w: number, h: number, preset: ParticlePreset, colors: string[]): CircleParticle[]
  update(p: CircleParticle, w: number, h: number, preset: ParticlePreset): void
  draw(ctx: CanvasRenderingContext2D, p: CircleParticle, preset: ParticlePreset): void
}
