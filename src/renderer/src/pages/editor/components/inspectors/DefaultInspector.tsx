// 📁 路径：src/renderer/src/pages/editor/components/inspectors/DefaultInspector.tsx
import React from 'react';
import { useI18n } from '../../../../store/useI18n';

interface DefaultInspectorProps {
  data?: any;
  updateParams?: (payload: any) => void;
}

export const DefaultInspector: React.FC<DefaultInspectorProps> = ({ data: _data }) => {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center justify-center h-full text-center p-6">
      <div className="text-[10px] text-zinc-500 italic p-2 bg-zinc-900 rounded">
        {(t.inspector?.default_no_params || '该节点暂无自定义参数')}
      </div>
    </div>
  );
};
