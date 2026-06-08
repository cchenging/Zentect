import { useState, useCallback } from 'react'

interface ValidationRule {
  required?: boolean
  pattern?: RegExp
  minLength?: number
  maxLength?: number
  custom?: (value: any) => string | null
}

interface ValidationResult {
  valid: boolean
  error?: string
}

interface FieldState {
  value: any
  touched: boolean
  error: string | null
}

/**
 * 表单验证 Hook
 * 支持失焦即时校验、pattern匹配、必填检查
 * 提供 validateField、validateAll、clearErrors 方法
 */
export function useFormValidation(initialFields: Record<string, ValidationRule> = {}) {
  const [fieldStates, setFieldStates] = useState<Record<string, FieldState>>({})
  const [formErrors, setFormErrors] = useState<Record<string, string | null>>({})

  /** 校验单个字段 */
  const validateField = useCallback((name: string, value: any, rule?: ValidationRule): ValidationResult => {
    const r = rule || initialFields[name]
    if (!r) return { valid: true }

    if (r.required) {
      if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
        return { valid: false, error: '此字段为必填项' }
      }
    }

    if (r.pattern && typeof value === 'string' && value.trim() !== '') {
      if (!r.pattern.test(value)) {
        return { valid: false, error: '格式不正确' }
      }
    }

    if (r.minLength && typeof value === 'string' && value.trim().length < r.minLength) {
      return { valid: false, error: `至少需要 ${r.minLength} 个字符` }
    }

    if (r.maxLength && typeof value === 'string' && value.trim().length > r.maxLength) {
      return { valid: false, error: `不能超过 ${r.maxLength} 个字符` }
    }

    if (r.custom) {
      const customError = r.custom(value)
      if (customError) return { valid: false, error: customError }
    }

    return { valid: true }
  }, [initialFields])

  /** 处理字段失焦 */
  const handleBlur = useCallback((name: string, value: any, rule?: ValidationRule) => {
    const result = validateField(name, value, rule)
    setFormErrors(prev => ({ ...prev, [name]: result.error || null }))
    setFieldStates(prev => ({ ...prev, [name]: { value, touched: true, error: result.error || null } }))
    return result
  }, [validateField])

  /** 处理字段值变化时清除错误 */
  const handleChange = useCallback((name: string, value: any) => {
    setFieldStates(prev => ({ ...prev, [name]: { ...prev[name], value, touched: true } }))
    setFormErrors(prev => {
      if (prev[name]) {
        const { [name]: _, ...rest } = prev
        return rest
      }
      return prev
    })
  }, [])

  /** 校验所有字段 */
  const validateAll = useCallback((fieldValues: Record<string, any>): boolean => {
    const errors: Record<string, string | null> = {}
    let allValid = true

    for (const [name, rule] of Object.entries(initialFields)) {
      const result = validateField(name, fieldValues[name], rule)
      errors[name] = result.error || null
      if (!result.valid) allValid = false
    }

    setFormErrors(errors)
    return allValid
  }, [initialFields, validateField])

  /** 清除所有错误 */
  const clearErrors = useCallback(() => {
    setFormErrors({})
    setFieldStates({})
  }, [])

  /** 设置指定字段错误 */
  const setFieldError = useCallback((name: string, error: string | null) => {
    setFormErrors(prev => ({ ...prev, [name]: error }))
  }, [])

  return {
    fieldStates,
    formErrors,
    validateField,
    validateAll,
    handleBlur,
    handleChange,
    clearErrors,
    setFieldError,
    isValid: Object.values(formErrors).every(e => e === null),
  }
}

export type { ValidationRule, ValidationResult, FieldState }