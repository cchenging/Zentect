/** V1.3 A3: StepExport 薄包装
 *  核心导出逻辑已抽取到 ExportPanel.tsx，本文件保留向后兼容
 */

import React from 'react';
import { ExportPanel } from './ExportPanel';

interface StepExportProps {
  projectId: string;
  onComplete?: () => void;
}

export const StepExport: React.FC<StepExportProps> = ({ projectId, onComplete: _onComplete }) => {
  return <ExportPanel projectId={projectId} container="page" />;
};