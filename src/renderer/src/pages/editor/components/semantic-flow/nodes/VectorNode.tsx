// 📁 路径：src/renderer/src/pages/editor/components/semantic-flow/nodes/VectorNode.tsx
import { Database } from 'lucide-react';
import { BaseNode } from './BaseNode';
import { useI18n } from '../../../../../store/useI18n';
import { NODE_MENU_CONFIG } from '../../../config/nodeMenu';

export const VectorNode = ({ id, data, selected }) => {
  const { t } = useI18n();
  const vn = t.nodes?.vector || {};
  const config = NODE_MENU_CONFIG.flatMap(c => c.items).find(i => i.type === 'vectorNode');
  const Icon = config?.icon || Database;

  const DisplayCore = (
    <div className="flex flex-col gap-1 px-1 pb-1">
      <div className="flex justify-between items-center text-[11px]">
        <span className="text-zinc-500">{vn.status_label || '状态'}</span>
        <span className={`font-medium capitalize ${data.status === 'processing' ? 'text-blue-400' : data.status === 'error' ? 'text-red-400' : 'text-emerald-400'}`}>
          {data.status === 'error' ? (vn.status_error || '异常') : data.status === 'processing' ? (vn.status_indexing || '索引中') : (vn.status_ready || '就绪')}
        </span>
      </div>
      <div className="flex justify-between items-center text-[10px]">
        <span className="text-zinc-500">{vn.dim_label || '维度'}</span>
        <span className="text-zinc-300">{data.dimensions || data.results?.dimensions || '1536'}</span>
      </div>
    </div>
  );

  return (
    <BaseNode
      id={id} selected={selected}
      title={data.label || (vn.title || '特征向量库')}
      icon={<Icon size={14} />}
      accent="emerald"
      variant="minimal"
      themeColor={config?.color}
      themeBg={config?.bg}
      width={180}
      status={data.status === 'processing' ? 'processing' : (data.status === 'error' ? 'error' : 'success')}
      inputs={true}
      outputs={true}
    >
      {DisplayCore}
    </BaseNode>
  );

  return (
    <BaseNode
      id={id} selected={selected}
      title={data.label || '特征向量库'}
      icon={<Icon size={14} />}
      accent="emerald"
      variant="minimal"
      themeColor={config?.color}
      themeBg={config?.bg}
      width={180}
      status={data.status === 'processing' ? 'processing' : (data.status === 'error' ? 'error' : 'success')}
      inputs={true}
      outputs={true}
    >
      <div className="flex flex-col gap-1 px-1 pb-1">
        <div className="flex justify-between items-center text-[11px]">
          <span className="text-zinc-500">状态</span>
          <span className={`font-medium capitalize ${data.status === 'processing' ? 'text-blue-400' : data.status === 'error' ? 'text-red-400' : 'text-emerald-400'}`}>
            {data.status === 'error' ? '异常' : data.status === 'processing' ? '索引中' : '就绪'}
          </span>
        </div>
        <div className="flex justify-between items-center text-[10px]">
          <span className="text-zinc-500">维度</span>
          <span className="text-zinc-300">{data.dimensions || data.results?.dimensions || '1536'}</span>
        </div>
      </div>
    </BaseNode>
  );
};
