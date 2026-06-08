import React, { useRef, useEffect, useCallback } from 'react'

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  opacity: number
  life: number
  maxLife: number
  color: string
}

interface ParticleEngineProps {
  className?: string
  particleCount?: number
}

/**
 * 蒲公英粒子引擎
 * Canvas 渲染青色半透明粒子飘动动画
 * 模拟蒲公英飘散效果，使用 requestAnimationFrame 非阻塞模式
 * 不阻塞页面交互，FPS 保持 60+
 */
const ParticleEngine: React.FC<ParticleEngineProps> = ({ className, particleCount = 40 }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animFrameRef = useRef<number>(0)
  const particlesRef = useRef<Particle[]>([])
  const prefersReducedMotion = useRef(false)

  /** 初始化粒子 */
  const initParticles = useCallback((width: number, height: number) => {
    const particles: Particle[] = []
    for (let i = 0; i < particleCount; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.5,
        vy: -Math.random() * 0.8 - 0.1,
        radius: Math.random() * 2.5 + 1,
        opacity: Math.random() * 0.4 + 0.1,
        life: Math.random() * 300,
        maxLife: 300 + Math.random() * 200,
        color: Math.random() > 0.5 ? 'rgba(0, 229, 255, VAR)' : 'rgba(99, 102, 241, VAR)',
      })
    }
    return particles
  }, [particleCount])

  useEffect(() => {
    /** 检测减少动效偏好 */
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

    /** 调整 Canvas 尺寸 */
    const resize = () => {
      if (!canvas) return
      const parent = canvas.parentElement
      if (!parent) return
      const rect = parent.getBoundingClientRect()
      canvas.width = rect.width * window.devicePixelRatio
      canvas.height = rect.height * window.devicePixelRatio
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio)
      particlesRef.current = initParticles(rect.width, rect.height)
    }

    resize()
    window.addEventListener('resize', resize)

    /** 动画循环 */
    const animate = () => {
      if (!ctx || !canvas) return
      const width = canvas.width / window.devicePixelRatio
      const height = canvas.height / window.devicePixelRatio

      ctx.clearRect(0, 0, width, height)

      if (prefersReducedMotion.current) {
        animFrameRef.current = requestAnimationFrame(animate)
        return
      }

      const particles = particlesRef.current

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i]

        p.x += p.vx + Math.sin(p.life * 0.02) * 0.15
        p.y += p.vy

        p.life++

        const lifeRatio = p.life / p.maxLife
        const currentOpacity = p.opacity * (1 - lifeRatio) * (lifeRatio < 0.1 ? lifeRatio * 10 : 1)

        if (p.life >= p.maxLife || p.y < -20 || p.x < -20 || p.x > width + 20) {
          p.x = Math.random() * width
          p.y = height + 20
          p.life = 0
          p.maxLife = 300 + Math.random() * 200
          p.vx = (Math.random() - 0.5) * 0.5
          p.vy = -Math.random() * 0.8 - 0.1
          p.opacity = Math.random() * 0.4 + 0.1
        }

        ctx.beginPath()
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2)
        ctx.fillStyle = p.color.replace('VAR', String(currentOpacity))
        ctx.fill()
      }

      animFrameRef.current = requestAnimationFrame(animate)
    }

    animFrameRef.current = requestAnimationFrame(animate)

    return () => {
      cancelAnimationFrame(animFrameRef.current)
      window.removeEventListener('resize', resize)
      motionQuery.removeEventListener('change', handleMotionChange)
    }
  }, [initParticles])

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