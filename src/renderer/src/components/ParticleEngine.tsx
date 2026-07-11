import React, { useRef, useEffect, useCallback } from 'react'
import type { ParticlePreset, CircleParticle } from './particles/types'
import { particlePresets } from './particles/particlePresets'
import { circleRenderer } from './particles/circleRenderer'

/* ============================================================
   ParticleEngine · 粒子引擎壳（策略模式）
   
   管理 canvas / rAF / resize / devicePixelRatio / reduced-motion。
   粒子逻辑委托给 renderer（circleRenderer），差异由 preset 参数表控制。

   使用：
     <ParticleEngine preset={particlePresets.stardust} />
     <ParticleEngine profile="dandelion" />  // 向后兼容
   ============================================================ */

type BackCompatProfile = 'v3' | 'dandelion' | 'none'

interface ParticleEngineProps {
  className?: string
  /**
   * 粒子预设对象（来自 particlePresets）。
   * 优先级高于 profile。
   */
  preset?: ParticlePreset
  /**
   * 向后兼容：'v3'/'dandelion' → dandelion, 'none' → none
   * preset 未传时使用。
   */
  profile?: BackCompatProfile
  /**
   * 预解析的颜色模板列表 ["rgba(R,G,B,VAR)", ...]。
   * 未传时自动从 preset.colorTokens 读取 CSS 变量解析。
   */
  colors?: string[]
}

// ──────────── 颜色解析 ────────────

function hexToRgb(hex: string): [number, number, number] | null {
  const h = hex.replace('#', '').trim()
  if (h.length === 3) {
    return [
      parseInt(h[0] + h[0], 16),
      parseInt(h[1] + h[1], 16),
      parseInt(h[2] + h[2], 16),
    ]
  }
  if (h.length >= 6) {
    return [
      parseInt(h.substring(0, 2), 16),
      parseInt(h.substring(2, 4), 16),
      parseInt(h.substring(4, 6), 16),
    ]
  }
  return null
}

function parseColor(value: string): [number, number, number] | null {
  if (!value) return null
  // hex
  if (value.startsWith('#')) return hexToRgb(value)
  // rgb(a)
  const m = value.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/)
  if (m) return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])]
  return null
}

/** 从 CSS 变量名列表解析为 "rgba(R,G,B,VAR)" 模板数组 */
function resolveColors(tokenNames: string[]): string[] {
  const style = getComputedStyle(document.documentElement)
  const colors: string[] = []
  for (const name of tokenNames) {
    const raw = style.getPropertyValue(name).trim()
    if (!raw) continue
    const rgb = parseColor(raw)
    if (rgb) {
      colors.push(`rgba(${rgb[0]},${rgb[1]},${rgb[2]},VAR)`)
    }
  }
  // 兜底
  if (colors.length === 0) colors.push('rgba(99,102,241,VAR)')
  return colors
}

/** profile 字符串 → preset */
function resolvePreset(profile?: BackCompatProfile): ParticlePreset {
  if (profile === 'none') return particlePresets.none
  return particlePresets.dandelion // 'v3' | 'dandelion' | undefined 都走 dandelion
}

// ──────────── 组件 ────────────

const ParticleEngine: React.FC<ParticleEngineProps> = ({
  className,
  profile,
  preset,
  colors: colorsProp,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animFrameRef = useRef<number>(0)
  const particlesRef = useRef<CircleParticle[]>([])
  const prefersReducedMotion = useRef(false)

  // 确定生效的 preset
  const effectivePreset = preset ?? resolvePreset(profile)

  // 解析颜色（依赖 preset 的 colorTokens）
  const resolvedColors = colorsProp ?? resolveColors(effectivePreset.colorTokens)

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
    particlesRef.current = circleRenderer.init(w, h, p, colorsRef.current)
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
      if (p.count === 0) {
        animFrameRef.current = requestAnimationFrame(animate)
        return
      }

      const ps = particlesRef.current
      for (let i = 0; i < ps.length; i++) {
        circleRenderer.update(ps[i], w, h, p, colorsRef.current)
        circleRenderer.draw(ctx, ps[i], p)
      }

      animFrameRef.current = requestAnimationFrame(animate)
    }

    animFrameRef.current = requestAnimationFrame(animate)

    return () => {
      cancelAnimationFrame(animFrameRef.current)
      window.removeEventListener('resize', resize)
      motionQuery.removeEventListener('change', handleMotionChange)
    }
  }, [effectivePreset.id, initParticles])

  // none 预设不渲染 canvas
  if (effectivePreset.count === 0) return null

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
