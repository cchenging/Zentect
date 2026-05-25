import { useState, useEffect, useCallback } from 'react';
import { API } from '../../../api';
import { AppNotifier } from '../../../core/AppNotifier';

// Schema：定义所有设置的键名及其默认值
const DEFAULT_SETTINGS_SCHEMA: Record<string, any> = {
  jianyingPath: '',
  deepseekKey: '', deepseekModels: null,
  qwenKey: '', qwenModels: null,
  doubaoKey: '', doubaoModels: null,
  tencentKey: '', tencentModels: null,
  openaiKey: '', openaiBaseUrl: 'https://api.openai.com/v1', openaiModels: null,
  taskVisualModel: 'qwen-vl-max', taskScriptModel: 'deepseek-chat',
  taskTranslateModel: 'qwen-plus', taskHelperModel: 'gpt-4o-mini',
  ttsProvider: 'edge', sovitsUrl: 'http://127.0.0.1:9880',
  fishKey: '', doubaoTtsAppId: '', doubaoTtsToken: '', doubaoTtsVoice: 'zh_female_meilinvyou_saturn_bigtts',
  enableGpuAcceleration: false
};

const parseModels = (val: any, defaultModels: string[]) => {
  if (Array.isArray(val)) {
    const cleanArr = val.map(String).map(s => s.trim()).filter(s => s.length > 0);
    return cleanArr.length > 0 ? cleanArr : defaultModels;
  }
  if (typeof val === 'string' && val.trim()) {
    if (val.includes('[object Object]') || val.includes('success":')) return defaultModels;
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) {
        const cleanParsed = parsed.map(String).map(s => s.trim()).filter(s => s.length > 0);
        return cleanParsed.length > 0 ? cleanParsed : defaultModels;
      }
    } catch (e) {}
    const strArray = val.split(',').map(s => s.trim()).filter(s => s.length > 0);
    return strArray.length > 0 ? strArray : defaultModels;
  }
  return defaultModels;
};

/**
 * Settings 数据管理 Hook
 * 通过 Schema 驱动，消灭硬编码的逐个 API 调用
 */
export const useSettingsManager = () => {
  const [config, setConfig] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'general' | 'ai' | 'export' | 'models' | 'health'>('general');
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [modelPool, setModelPool] = useState<string[]>([]);

  const rebuildModelPool = useCallback((values: any) => {
    const m1 = Array.isArray(values.deepseekModels) ? values.deepseekModels : [];
    const m2 = Array.isArray(values.qwenModels) ? values.qwenModels : [];
    const m3 = Array.isArray(values.tencentModels) ? values.tencentModels : [];
    const m4 = Array.isArray(values.doubaoModels) ? values.doubaoModels : [];
    const m5 = Array.isArray(values.openaiModels) ? values.openaiModels : [];
    setModelPool(Array.from(new Set([...m1, ...m2, ...m3, ...m4, ...m5])));
  }, []);

  // 💥 增量更新点：基于 Schema 批量拉取配置
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const systemPaths = await API.system.getPaths();

        // 并发执行 Schema 中的所有 getSetting 任务
        const fetchPromises = Object.entries(DEFAULT_SETTINGS_SCHEMA).map(async ([key, defaultVal]) => {
          const val = await API.system.getSetting(key, defaultVal);
          return [key, val];
        });

        const resultsArray = await Promise.all(fetchPromises);
        const dynamicSettings = Object.fromEntries(resultsArray);

        const loadedData = {
          projectPath: systemPaths.projects,
          exportPath: systemPaths.exports,
          ...dynamicSettings,
          // 单独对需要清洗的 Model 字段进行防脏数据拦截
          deepseekModels: parseModels(dynamicSettings.deepseekModels, ['deepseek-chat', 'deepseek-reasoner']),
          qwenModels: parseModels(dynamicSettings.qwenModels, ['qwen-max', 'qwen-plus', 'qwen-vl-max']),
          doubaoModels: parseModels(dynamicSettings.doubaoModels, []),
          tencentModels: parseModels(dynamicSettings.tencentModels, ['hunyuan-lite', 'hunyuan-pro', 'hunyuan-vision']),
          openaiModels: parseModels(dynamicSettings.openaiModels, ['gpt-4o', 'claude-3-5-sonnet-20240620']),
        };

        setConfig(loadedData);
        rebuildModelPool(loadedData);
      } catch (error) {
        AppNotifier.error('配置文件读取失败', error);
        setConfig({});
      }
    };
    fetchConfig();
  }, [rebuildModelPool]);

  const updateConfig = useCallback((_section: string, key: string, value: any) => {
    setConfig((prev: any) => {
      const updated = { ...prev, [key]: value };
      if (String(key).includes('Models')) rebuildModelPool(updated);
      return updated;
    });
  }, [rebuildModelPool]);

  // 💥 增量更新点：基于 Schema 自动保存，取代长串硬编码
  const saveConfig = async () => {
    setIsSaving(true);
    try {
      const savePromises = Object.keys(DEFAULT_SETTINGS_SCHEMA).map(key => {
        // 对 Models 字段做兜底转存保证
        const valueToSave = String(key).includes('Models') ? (config[key] || []) : config[key];
        return API.system.setSetting(key, valueToSave);
      });

      // 特殊处理系统路径
      savePromises.push(API.system.setSetting('projectPath', config.projectPath));
      savePromises.push(API.system.setSetting('exportPath', config.exportPath));

      await Promise.all(savePromises);
      AppNotifier.success('保存成功');
      return true;
    } catch (e: any) {
      AppNotifier.error(e.message || '保存失败');
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const testAIConnection = async (type: string, providerName: string, configData: any, saveKey?: string) => {
    if (saveKey) await API.system.setSetting(saveKey, config[saveKey] || '');
    AppNotifier.info(`正在连接 ${providerName}...`);
    setIsTesting(true);
    try {
      const msg = await API.ai.testNetwork(type, configData);
      AppNotifier.success(msg);
    } catch (e: any) {
      AppNotifier.error(e.message || '连接失败');
    } finally {
      setIsTesting(false);
    }
  };

  const testTTS = async () => {
    const engineToTest = config.ttsProvider || 'edge';
    if (engineToTest === 'doubao' && (!config.doubaoTtsAppId || !config.doubaoTtsToken)) {
      return AppNotifier.warn('请填写 App ID 和 Token');
    }
    try {
      await Promise.all([
        API.system.setSetting('ttsProvider', engineToTest),
        API.system.setSetting('doubaoTtsAppId', config.doubaoTtsAppId || ''),
        API.system.setSetting('doubaoTtsToken', config.doubaoTtsToken || ''),
        API.system.setSetting('doubaoTtsVoice', config.doubaoTtsVoice || ''),
        API.system.setSetting('fishKey', config.fishKey || ''),
        API.system.setSetting('sovitsUrl', config.sovitsUrl || '')
      ]);
    } catch (e) {}

    AppNotifier.info('正在请求合成...');
    try {
      const audioUrl = await API.ai.testTTS(engineToTest);
      const audio = new Audio(audioUrl); audio.play();
      AppNotifier.success('合成成功');
    } catch (err: any) {
      AppNotifier.error(err.message || '请求失败');
    }
  };

  return {
    config, activeTab, setActiveTab, updateConfig, saveConfig,
    testAIConnection, testTTS, isTesting, isSaving, modelPool
  };
};
