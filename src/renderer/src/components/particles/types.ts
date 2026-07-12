/* ============================================================
   粒子系统共享类型
   架构：MotionEngine(运动学) + ShapeDrawer(绘制) 分离
   ============================================================ */

/** 粒子形态枚举 —— 决定 draw 路由，与名字语义一致 */
export type ParticleShape = 'dandelion' | 'stardust' | 'dust' | 'snow' | 'firefly' | 'none'

/** 预设定义（驱动参数化粒子行为） */
export interface ParticlePreset {
  id: string
  name: string
  /** 形态 —— 路由到对应 ShapeDrawer */
  shape: ParticleShape
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

/** 粒子实例（运动学通用 + 形态字段）
 *  size 在不同形态含义不同：圆点=半径 / 方块=半边长 / 星芒=光芒长 / 雪花=外接半径 / 光晕=核心半径 */
export interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  size: number
  opacity: number
  life: number
  maxLife: number
  /** 预解析颜色模板 "rgba(R,G,B,VAR)"，VAR 为帧级透明度占位 */
  color: string
  twinklePhase: number
  /** 旋转角度（雪花/星芒/蒲公英用） */
  rotation: number
  /** 旋转角速度 */
  rotationSpeed: number
}

/** 预设 ID 联合类型 */
export type ParticlePresetId = string

/** 运动引擎接口：管理粒子位置/生命周期/重生（与形态无关，全部形态共用） */
export interface MotionEngine {
  init(w: number, h: number, preset: ParticlePreset, colors: string[]): Particle[]
  update(p: Particle, w: number, h: number, preset: ParticlePreset, colors: string[]): void
}

/** 形态绘制器接口：只管"画成什么样"，按 preset.shape 路由 */
export interface ShapeDrawer {
  draw(ctx: CanvasRenderingContext2D, p: Particle, preset: ParticlePreset, opacity: number): void
}

/** @deprecated 已被 Particle 取代，保留别名兼容旧引用 */
export type CircleParticle = Particle
/** @deprecated 已被 MotionEngine + ShapeDrawer 取代，保留别名兼容旧引用 */
export type ParticleRenderer = MotionEngine
