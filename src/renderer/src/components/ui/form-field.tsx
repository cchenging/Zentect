import React from 'react'
import { Check, AlertCircle } from 'lucide-react'
import { cn } from '../../lib/utils'

interface FormFieldProps {
  label?: string
  error?: string | null
  valid?: boolean
  required?: boolean
  children: React.ReactNode
  className?: string
  hint?: string
}

/**
 * 表单字段包装组件
 * 提供内联校验提示：错误红色文字、通过绿色勾号
 * 支持失焦即时校验提示
 */
const FormField: React.FC<FormFieldProps> = ({ label, error, valid, required, children, className, hint }) => {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {label && (
        <div className="flex items-center gap-1">
          <span className="text-xs text-foreground font-medium">{label}</span>
          {required && <span className="text-accent-rose text-[10px]">*</span>}
        </div>
      )}
      <div className="relative">
        {children}
        {valid && !error && (
          <Check size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-accent-green" />
        )}
      </div>
      {error && (
        <div className="flex items-center gap-1 text-[10px] text-accent-rose animate-fade-in">
          <AlertCircle size={10} />
          <span>{error}</span>
        </div>
      )}
      {hint && !error && (
        <span className="text-[10px] text-muted-foreground">{hint}</span>
      )}
    </div>
  )
}

FormField.displayName = 'FormField'

export { FormField }
export type { FormFieldProps }