import { useCallback, useMemo } from 'react'
import { useUserStore } from '../store/useUserStore'

const DAILY_LIMIT_KEY = 'zentect_ai_daily_count'
const DAILY_DATE_KEY = 'zentect_ai_daily_date'
const FREE_DAILY_LIMIT = 3

/**
 * 功能门控 Hook
 * 根据用户 VIP 等级限制功能使用
 * 免费用户每日 AI 管线调用上限 3 次
 * VIP 用户无限制
 * 计数器本地持久化（localStorage）
 */
export function useFeatureGate() {
  const isLoggedIn = useUserStore((s) => s.isLoggedIn)
  const vipLevel = useUserStore((s) => s.userInfo?.vipLevel || 'free')

  /** 获取今日调用次数 */
  const getDailyCount = useCallback((): number => {
    try {
      const today = new Date().toDateString()
      const savedDate = localStorage.getItem(DAILY_DATE_KEY)
      if (savedDate !== today) {
        localStorage.setItem(DAILY_DATE_KEY, today)
        localStorage.setItem(DAILY_LIMIT_KEY, '0')
        return 0
      }
      return parseInt(localStorage.getItem(DAILY_LIMIT_KEY) || '0', 10)
    } catch {
      return 0
    }
  }, [])

  /** 增加调用次数 */
  const incrementDailyCount = useCallback(() => {
    try {
      const today = new Date().toDateString()
      const savedDate = localStorage.getItem(DAILY_DATE_KEY)
      const count = savedDate === today
        ? parseInt(localStorage.getItem(DAILY_LIMIT_KEY) || '0', 10) + 1
        : 1
      localStorage.setItem(DAILY_DATE_KEY, today)
      localStorage.setItem(DAILY_LIMIT_KEY, String(count))
    } catch {}
  }, [])

  /** 检查功能是否可用 */
  const canUseFeature = useCallback((feature: string): boolean => {
    if (!isLoggedIn) return true
    if (vipLevel !== 'free') return true

    if (feature === 'ai_pipeline') {
      const count = getDailyCount()
      return count < FREE_DAILY_LIMIT
    }

    return true
  }, [isLoggedIn, vipLevel, getDailyCount])

  /** 获取剩余次数 */
  const remainingCount = useMemo(() => {
    if (!isLoggedIn) return Infinity
    if (vipLevel !== 'free') return Infinity
    return Math.max(0, FREE_DAILY_LIMIT - getDailyCount())
  }, [isLoggedIn, vipLevel, getDailyCount])

  /** 获取限制提示文案 */
  const limitMessage = useMemo(() => {
    if (!isLoggedIn) return null
    if (vipLevel !== 'free') return null
    if (remainingCount <= 0) {
      return '今日免费次数已用完，升级 VIP 解锁无限次数'
    }
    return `今日剩余 ${remainingCount} 次免费调用`
  }, [isLoggedIn, vipLevel, remainingCount])

  return {
    canUseFeature,
    incrementDailyCount,
    remainingCount,
    limitMessage,
    isFree: isLoggedIn && vipLevel === 'free',
    isVip: isLoggedIn && vipLevel !== 'free',
    dailyLimit: FREE_DAILY_LIMIT,
  }
}