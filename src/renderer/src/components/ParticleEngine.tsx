import React, { useRef, useEffect, useCallback, useMemo } from 'react'
import type { ParticlePreset, Particle } from './particles/types'
import { particlePresets } from './particles/particlePresets'
import { motionEngine } from './particles/motion'
import { shapeDrawers } from './particles/shapes'
import { resolveColors } from './particles/colors'

/* ============================================================
   ParticleEngine · 粒子引擎壳（策略模式）

   管理 canvas / rAF / resize / devicePixelRatio / reduced-motion。
   运动学委托 motionEngine（共享），绘制委托 shapeDrawers[preset.shape]。
   颜色由外部传入（Container 解析，随 skin 重算）或兜底自解析。

   使用：
     <ParticleEngine preset={particlePresets.stardust} colors={colors} />
     <ParticleEngine profile="dandelion" />  // 向后兼容
   ============================================================ */

type BackCompatProfile = 'v3' | 'dandelion' | 'none'

interface ParticleEngineProps {
  className?: string
  /** 粒子预设对象（来自 particlePresets） */
  preset?: ParticlePreset
  /** 向后兼容：'v3'/'dandelion' → dandelion, 'none' → none */
  profile?: BackCompatProfile
  /** 预解析的颜色模板列表（推荐由 Container 传入，随 skin 重算）。
   *  未传时自动从 preset.colorTokens 解析。 */
  colors?: string[]
}

/** profile 字符串 → preset */
function resolvePreset(profile?: BackCompatProfile): ParticlePreset {
  if (profile === 'none') return particlePresets.none
  return particlePresets.dandelion
}

const ParticleEngine: React.FC<ParticleEngineProps> = ({
  className,
  profile,
  preset,
  colors: colorsProp,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animFrameRef = useRef<number>(0)
  const particlesRef = useRef<Particle[]>([])
  const prefersReducedMotion = useRef(false)

  const effectivePreset = preset ?? resolvePreset(profile)

  // 颜色：优先外部传入；兜底自解析（useMemo 避免每次 render 重算 getComputedStyle）
  const resolvedColors = useMemo(
    () => colorsProp ?? resolveColors(effectivePreset.colorTokens),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [colorsProp, effectivePreset.id, effectivePreset.colorTokens.join(',')],
  )

  // 缓存最新值，避免动画闭包过时
  const presetRef = useRef(effectivePreset)
  const colorsRef = useRef(resolvedColors)
  presetRef.current = effectivePreset
  colorsRef.current = resolvedColors

  const initParticles = useCallback((w: number, h: number) => {
    const p = presetRef.current
    if (p.count === 0) {
      particlesRef.current = []
      return
    }
    particlesRef.current = motionEngine.init(w, h, p, colorsRef.current)
  }, [])

  useEffect(() => {
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    prefersReducedMotion.current = motionQuery.matches
    const handleMotionChange = (e: MediaQueryListEvent) => {
      prefersReducedMotion.current = e.matches
    }
    motionQuery.addEventListener('change', handleMotionChange)

    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // --- resize ---
    const resize = () => {
      if (!canvas) return
      const parent = canvas.parentElement
      if (!parent) return
      const rect = parent.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      initParticles(rect.width, rect.height)
    }

    resize()
    window.addEventListener('resize', resize)

    // --- 动画循环 ---
    const animate = () => {
      if (!ctx || !canvas) return
      const w = canvas.width / (window.devicePixelRatio || 1)
      const h = canvas.height / (window.devicePixelRatio || 1)
      ctx.clearRect(0, 0, w, h)

      if (prefersReducedMotion.current) {
        animFrameRef.current = requestAnimationFrame(animate)
        return
      }

      const p = presetRef.current
      const shape = p.shape
      if (p.count === 0 || shape === 'none') {
        animFrameRef.current = requestAnimationFrame(animate)
        return
      }

      const drawer = shapeDrawers[shape]
      if (!drawer) {
        animFrameRef.current = requestAnimationFrame(animate)
        return
      }

      const ps = particlesRef.current
      for (let i = 0; i < ps.length; i++) {
        const part = ps[i]
        motionEngine.update(part, w, h, p, colorsRef.current)

        // 帧级透明度（生命周期淡入淡出 + 闪烁）
        const lifeRatio = part.life / part.maxLife
        let op = part.opacity * (1 - lifeRatio) * (lifeRatio < 0.1 ? lifeRatio * 10 : 1)
        if (p.twinkle) op *= 0.5 + 0.5 * Math.sin(part.twinklePhase)
        if (op > 0) drawer.draw(ctx, part, p, op)
      }

      animFrameRef.current = requestAnimationFrame(animate)
    }

    animFrameRef.current = requestAnimationFrame(animate)

    return () => {
      cancelAnimationFrame(animFrameRef.current)
      window.removeEventListener('resize', resize)
      motionQuery.removeEventListener('change', handleMotionChange)
    }
  }, [effectivePreset.id, resolvedColors.join(','), initParticles])

  // none 预设不渲染 canvas
  if (effectivePreset.count === 0 || effectivePreset.shape === 'none') return null

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ pointerEvents: 'none', position: 'absolute', top: 0, left: 0 }}
      aria-hidden="true"
    />
  )
}

ParticleEngine.displayName = 'ParticleEngine'

export { ParticleEngine }
export default ParticleEngine
