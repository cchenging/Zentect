import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { zhCN } from '../../../modules/infra/i18n/zh-CN';

const locales = { 'zh-CN': zhCN };
type LangType = keyof typeof locales;

interface I18nStore {
  lang: LangType;
  t: typeof zhCN;
  setLang: (lang: LangType) => void;
}

export const useI18n = create<I18nStore>()(
  persist(
    (set) => ({
      lang: 'zh-CN',
      t: locales['zh-CN'],
      setLang: (lang) => set({ lang, t: locales[lang] }),
    }),
    {
      name: 'i18n-storage',
    }
  )
);
