import React, { useState } from 'react'
import { Bell, Check, Trash2, X } from 'lucide-react'
import { useNotificationCenter } from '../../services/NotificationCenter'
import { cn } from '../../lib/utils'

interface NotificationPanelProps {
  className?: string
}

const LEVEL_CONFIG: Record<string, { bg: string; text: string; border: string }> = {
  info: { bg: 'bg-accent/10', text: 'text-accent', border: 'border-accent/20' },
  success: { bg: 'bg-accent-green/10', text: 'text-accent-green', border: 'border-accent-green/20' },
  warn: { bg: 'bg-accent-warm/10', text: 'text-accent-warm', border: 'border-accent-warm/20' },
  error: { bg: 'bg-accent-rose/10', text: 'text-accent-rose', border: 'border-accent-rose/20' },
}

/**
 * 通知下拉面板
 * 320px 宽面板，显示通知列表，支持标记已读/全部清除
 * 数据层使用 NotificationCenter Zustand store
 */
const NotificationPanel: React.FC<NotificationPanelProps> = ({ className }) => {
  const [isOpen, setIsOpen] = useState(false)
  const { notifications, unreadCount, markRead, markAllRead, removeNotification, clearAll } = useNotificationCenter()

  const formatTime = (timestamp: number): string => {
    const diff = Date.now() - timestamp
    if (diff < 60000) return '刚刚'
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`
    return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
  }

  return (
    <div className={cn('relative', className)}>
      {/* Bell 图标按钮 */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative w-9 h-9 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer outline-none"
        title="通知中心"
      >
        <Bell size={17} />
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 min-w-[16px] h-4 flex items-center justify-center rounded-full bg-accent-rose text-white text-[9px] font-bold px-1 leading-none">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* 下拉面板 */}
      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute right-0 top-full mt-1.5 w-[320px] max-h-[420px] glass-card overflow-hidden flex flex-col z-50 shadow-lg border border-border/50 rounded-xl">
            {/* 面板头部 */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/30 shrink-0">
              <div className="flex items-center gap-2">
                <Bell size={15} className="text-accent" />
                <span className="text-[13px] font-semibold text-foreground">通知中心</span>
                {unreadCount > 0 && (
                  <span className="text-[10px] text-muted-foreground">{unreadCount} 条未读</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {unreadCount > 0 && (
                  <button
                    onClick={markAllRead}
                    className="flex items-center gap-1 px-2 py-1 text-[10px] text-accent-cyan hover:text-accent-cyan hover:bg-accent-cyan/5 rounded-md transition-colors cursor-pointer outline-none"
                    title="全部已读"
                  >
                    <Check size={12} /> 全部已读
                  </button>
                )}
                {notifications.length > 0 && (
                  <button
                    onClick={clearAll}
                    className="flex items-center gap-1 px-2 py-1 text-[10px] text-muted-foreground hover:text-accent-rose hover:bg-accent-rose/5 rounded-md transition-colors cursor-pointer outline-none"
                    title="全部清除"
                  >
                    <Trash2 size={12} /> 清除
                  </button>
                )}
                <button
                  onClick={() => setIsOpen(false)}
                  className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer outline-none"
                >
                  <X size={13} />
                </button>
              </div>
            </div>

            {/* 通知列表 */}
            <div className="flex-1 overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 px-4">
                  <Bell size={28} className="text-muted-foreground/30 mb-3" />
                  <span className="text-[12px] text-muted-foreground">暂无通知</span>
                  <span className="text-[10px] text-muted-foreground/60 mt-1">新通知将在此显示</span>
                </div>
              ) : (
                <div className="flex flex-col">
                  {notifications.map((item) => {
                    const config = LEVEL_CONFIG[item.level] || LEVEL_CONFIG.info
                    return (
                      <div
                        key={item.id}
                        className={cn(
                          'flex items-start gap-3 px-4 py-3 border-b border-border/20 hover:bg-white/[0.02] transition-colors cursor-pointer',
                          !item.read && 'bg-accent/3'
                        )}
                        onClick={() => {
                          if (!item.read) markRead(item.id)
                        }}
                      >
                        {/* 状态指示条 */}
                        <div className={cn('w-1.5 h-1.5 rounded-full mt-1.5 shrink-0', config.text.replace('text-', 'bg-'))} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className={cn('text-[12px] font-medium truncate', !item.read ? 'text-foreground' : 'text-muted-foreground')}>
                              {item.title}
                            </span>
                            <span className="text-[9px] text-muted-foreground/60 shrink-0">{formatTime(item.timestamp)}</span>
                          </div>
                          <p className={cn('text-[11px] mt-0.5 line-clamp-2', !item.read ? 'text-foreground/80' : 'text-muted-foreground/70')}>
                            {item.message}
                          </p>
                          {/* 操作按钮 */}
                          {item.actions && item.actions.length > 0 && (
                            <div className="flex items-center gap-2 mt-2">
                              {item.actions.map((action, idx) => (
                                <button
                                  key={idx}
                                  className={cn(
                                    'px-2.5 py-0.5 rounded-md text-[10px] font-medium transition-colors cursor-pointer outline-none',
                                    action.intent === 'primary' ? 'bg-accent/10 text-accent hover:bg-accent/20' : 'bg-muted text-muted-foreground hover:text-foreground hover:bg-muted/80'
                                  )}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                  }}
                                >
                                  {action.label}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        {/* 删除按钮 */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            removeNotification(item.id)
                          }}
                          className="w-5 h-5 flex items-center justify-center rounded text-muted-foreground/40 hover:text-accent-rose hover:bg-accent-rose/10 transition-colors cursor-pointer outline-none shrink-0 mt-0.5"
                          title="删除"
                        >
                          <X size={11} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

NotificationPanel.displayName = 'NotificationPanel'

export { NotificationPanel }
export default NotificationPanel