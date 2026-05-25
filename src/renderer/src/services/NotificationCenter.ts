import { create } from 'zustand'

interface NotificationItem {
  id: string
  title: string
  message: string
  level: 'info' | 'success' | 'warn' | 'error'
  timestamp: number
  read: boolean
  /** 关联的 traceId */
  traceId?: string
  /** 操作按钮 */
  actions?: Array<{
    label: string
    intent: string
    payload?: Record<string, unknown>
  }>
}

interface NotificationState {
  /** 通知列表 */
  notifications: NotificationItem[]
  /** 未读数量 */
  unreadCount: number
  /** 添加通知 */
  addNotification: (item: Omit<NotificationItem, 'id' | 'timestamp' | 'read'>) => void
  /** 标记已读 */
  markRead: (id: string) => void
  /** 全部已读 */
  markAllRead: () => void
  /** 删除通知 */
  removeNotification: (id: string) => void
  /** 清空所有 */
  clearAll: () => void
}

let notificationId = 0
const MAX_NOTIFICATIONS = 100

/**
 * 通知中心
 * 全局通知队列管理（Zustand store），
 * 支持未读计数、历史回溯、标记已读
 */
export const useNotificationCenter = create<NotificationState>((set) => ({
  notifications: [],
  unreadCount: 0,

  addNotification: (item) => {
    const id = `notif_${++notificationId}_${Date.now()}`
    const notification: NotificationItem = {
      ...item,
      id,
      timestamp: Date.now(),
      read: false
    }

    set((state) => {
      const updated = [notification, ...state.notifications].slice(0, MAX_NOTIFICATIONS)
      return {
        notifications: updated,
        unreadCount: updated.filter((n) => !n.read).length
      }
    })
  },

  markRead: (id) => {
    set((state) => {
      const updated = state.notifications.map((n) =>
        n.id === id ? { ...n, read: true } : n
      )
      return {
        notifications: updated,
        unreadCount: updated.filter((n) => !n.read).length
      }
    })
  },

  markAllRead: () => {
    set((state) => ({
      notifications: state.notifications.map((n) => ({ ...n, read: true })),
      unreadCount: 0
    }))
  },

  removeNotification: (id) => {
    set((state) => {
      const updated = state.notifications.filter((n) => n.id !== id)
      return {
        notifications: updated,
        unreadCount: updated.filter((n) => !n.read).length
      }
    })
  },

  clearAll: () => {
    set({ notifications: [], unreadCount: 0 })
  }
}))
