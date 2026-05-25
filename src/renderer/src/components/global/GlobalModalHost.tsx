import React, { useEffect } from 'react'
import { useNotificationCenter } from '../../services/NotificationCenter'

interface GlobalModalState {
  visible: boolean
  title: string
  message: string
  level: 'info' | 'warn' | 'error' | 'fatal'
  actions: Array<{
    label: string
    intent: string
    primary?: boolean
  }>
  onAction?: (intent: string) => void
}

let modalState: GlobalModalState = {
  visible: false,
  title: '',
  message: '',
  level: 'info',
  actions: []
}

const listeners = new Set<(state: GlobalModalState) => void>()

function notifyListeners() {
  for (const listener of listeners) {
    listener({ ...modalState })
  }
}

export const GlobalModalAPI = {
  /** 显示 Modal */
  show(config: Omit<GlobalModalState, 'visible'> & { onAction?: (intent: string) => void }) {
    modalState = { ...config, visible: true }
    notifyListeners()
  },

  /** 隐藏 Modal */
  hide() {
    modalState = { ...modalState, visible: false }
    notifyListeners()
  },

  /** 获取当前状态 */
  getState(): GlobalModalState {
    return { ...modalState }
  }
}

/**
 * 全局 Modal 宿主组件
 * 挂载在 App 根节点，由 FeedbackBus 事件驱动，
 * 用于 Pipeline 失败、配置缺失、凭证失效等全局提示
 */
export const GlobalModalHost: React.FC = () => {
  const [state, setState] = React.useState<GlobalModalState>(modalState)
  const addNotification = useNotificationCenter((s) => s.addNotification)

  useEffect(() => {
    const listener = (newState: GlobalModalState) => {
      setState({ ...newState })
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  if (!state.visible) return null

  const handleAction = (intent: string) => {
    state.onAction?.(intent)

    if (intent === 'dismiss' || intent === 'abort') {
      GlobalModalAPI.hide()
    }

    addNotification({
      title: `操作: ${intent}`,
      message: state.message,
      level: state.level === 'fatal' ? 'error' : state.level
    })
  }

  const levelStyles: Record<string, { border: string; bg: string }> = {
    info: { border: '#3b82f6', bg: '#eff6ff' },
    warn: { border: '#f59e0b', bg: '#fffbeb' },
    error: { border: '#ef4444', bg: '#fef2f2' },
    fatal: { border: '#7c3aed', bg: '#faf5ff' }
  }

  const style = levelStyles[state.level] || levelStyles.info

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.45)'
      }}
      onClick={() => GlobalModalAPI.hide()}
    >
      <div
        style={{
          backgroundColor: '#fff',
          borderRadius: 12,
          padding: '24px 28px',
          minWidth: 380,
          maxWidth: 520,
          boxShadow: '0 8px 30px rgba(0,0,0,0.18)',
          borderLeft: `4px solid ${style.border}`
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: '0 0 8px', fontSize: 17, fontWeight: 600 }}>
          {state.title}
        </h3>
        <p
          style={{
            margin: '0 0 20px',
            fontSize: 14,
            color: '#555',
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap'
          }}
        >
          {state.message}
        </p>

        {state.actions.length > 0 && (
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            {state.actions.map((action) => (
              <button
                key={action.intent}
                style={{
                  padding: '8px 18px',
                  borderRadius: 6,
                  border: action.primary ? 'none' : '1px solid #d1d5db',
                  backgroundColor: action.primary ? style.border : 'transparent',
                  color: action.primary ? '#fff' : '#333',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer'
                }}
                onClick={() => handleAction(action.intent)}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
