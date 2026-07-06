// Module: editor/shell/frontend/components/PropertyBar
// 原 editor/components/PropertyBar.tsx — 已迁移

import React from 'react'
import { Clock, Mic, User, Info } from 'lucide-react'
import { useStore } from '../../../../../../renderer/src/store/useStore'
import { cn } from '../../../../../../renderer/src/lib/utils'

interface PropertyBarProps {
  className?: string
}

const PropertyBar: React.FC<PropertyBarProps> = ({ className }) => {
  const shots = useStore((s) => s.shots)
  const roles = useStore((s) => s.roles)
  const selectedItemId = useStore((s) => s.selectedItemId)
  const selectedItemType = useStore((s) => s.selectedItemType)

  const selectedShot = selectedItemType === 'shot' && selectedItemId
    ? shots.find((s) => s.id === selectedItemId)
    : null

  const selectedRole = selectedShot?.roleId
    ? roles.find((r) => (r as any).id === selectedShot.roleId || (r as any).roleId === selectedShot.roleId)
    : null

  const roleName = selectedRole
    ? ((selectedRole as any).name || (selectedRole as any).roleName || '未命名角色')
    : null

  return (
    <div className={cn('flex items-center gap-4 px-4 py-2 border-b border-border/30 bg-bg-deep/50 shrink-0', className)}>
      {selectedShot ? (
        <>
          <div className="flex items-center gap-1.5">
            <User size={13} className="text-muted-foreground" />
            <span className="text-[10px] text-muted-foreground">角色</span>
            <span className="text-[11px] font-medium text-foreground">
              {roleName || '未分配'}
            </span>
          </div>

          <div className="w-px h-4 bg-border/30" />

          <div className="flex items-center gap-1.5">
            <Clock size={13} className="text-muted-foreground" />
            <span className="text-[10px] text-muted-foreground">时长</span>
            <span className="text-[11px] font-medium text-foreground">
              {selectedShot.duration || '00:05'}
            </span>
          </div>

          <div className="w-px h-4 bg-border/30" />

          <div className="flex items-center gap-1.5">
            <Mic size={13} className="text-muted-foreground" />
            <span className="text-[10px] text-muted-foreground">语速</span>
            <span className="text-[11px] font-medium text-foreground">
              {(selectedShot as any).audioEmotion || (selectedShot as any).speed || '正常'}
            </span>
          </div>

          <div className="w-px h-4 bg-border/30" />

          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <Info size={13} className="text-muted-foreground shrink-0" />
            <span className="text-[11px] text-muted-foreground truncate">
              {((selectedShot as any).aiText || (selectedShot as any).text || '暂无台词')}
            </span>
          </div>
        </>
      ) : (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Info size={13} className="opacity-50" />
          <span>点击卡片查看属性</span>
        </div>
      )}
    </div>
  )
}

PropertyBar.displayName = 'PropertyBar'

export { PropertyBar }
