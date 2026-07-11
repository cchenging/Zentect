// 📁 路径：src/modules/home/frontend/hooks/useWorkflowImport.ts
import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { API } from '../../../../renderer/src/api'
import { AppNotifier } from '../../../../renderer/src/core/AppNotifier'
import { FrontendLogger } from '../../../../renderer/src/utils/logger'

/**
 * 工作流导入 Hook
 * 支持选择 .json 工作流文件
 * 解析成功后创建新项目
 * 解析失败有明确错误提示
 */
export function useWorkflowImport() {
  const navigate = useNavigate()
  const [isImporting, setIsImporting] = useState(false)

  /** 导入工作流文件 */
  const importWorkflow = useCallback(async () => {
    setIsImporting(true)
    const traceId = FrontendLogger.generateTraceId()

    try {
      /** 打开文件选择器，限定 .json 类型 */
      const filePath = await API.system.openFile({
        filters: [{ name: '工作流文件', extensions: ['json'] }],
        properties: ['openFile'],
      })

      if (!filePath) {
        FrontendLogger.info('WorkflowImport', 'User cancelled file selection', traceId)
        setIsImporting(false)
        return
      }

      FrontendLogger.info('WorkflowImport', 'Selected workflow file', traceId, { filePath })

      /** 读取文件内容 */
      const content = await API.system.readFile(filePath)
      if (!content) {
        AppNotifier.error('读取文件失败，请检查文件是否可访问')
        setIsImporting(false)
        return
      }

      /** 解析 JSON */
      let workflowData: any
      try {
        workflowData = JSON.parse(content)
      } catch {
        AppNotifier.error('工作流格式无效：文件内容不是合法的 JSON 格式')
        setIsImporting(false)
        return
      }

      /** 验证工作流结构 */
      if (!workflowData || typeof workflowData !== 'object') {
        AppNotifier.error('工作流格式无效：缺少必要的数据结构')
        setIsImporting(false)
        return
      }

      /** 检查必要字段 */
      const requiredFields = ['name', 'steps']
      const missingFields = requiredFields.filter(f => !(f in workflowData))
      if (missingFields.length > 0) {
        AppNotifier.error(`工作流格式无效：缺少 ${missingFields.join(', ')} 字段`)
        setIsImporting(false)
        return
      }

      FrontendLogger.info('WorkflowImport', 'Workflow file validated successfully', traceId, {
        name: workflowData.name,
        stepsCount: workflowData.steps?.length,
      })

      /** 创建项目并导入工作流 */
      try {
        const result = await API.project.create({ type: 'workflow', workflowData })
        if (result?.id) {
          AppNotifier.success(`工作流「${workflowData.name}」导入成功`)
          FrontendLogger.info('WorkflowImport', 'Workflow project created', traceId, { projectId: result.id })
          navigate(`/editor/${result.id}`)
        }
      } catch (err: any) {
        AppNotifier.error(err.message || '创建项目失败，请稍后重试')
        FrontendLogger.error('WorkflowImport', 'Failed to create project from workflow', traceId, err.message)
      }
    } catch (err: any) {
      AppNotifier.error(err.message || '导入失败，请稍后重试')
      FrontendLogger.error('WorkflowImport', 'Import workflow failed', traceId, err.message)
    } finally {
      setIsImporting(false)
    }
  }, [navigate])

  return { importWorkflow, isImporting }
}
