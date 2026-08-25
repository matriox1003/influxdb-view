import { create } from 'zustand';
import { getApi } from '@/types';

export type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeState {
  mode: ThemeMode;
  /** 实际生效主题（system 解析后） */
  resolved: 'light' | 'dark';
  load: () => Promise<void>;
  setMode: (mode: ThemeMode) => Promise<void>;
  applyToDom: () => void;
}

function resolveSystem(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: 'system',
  resolved: 'light',

  load: async () => {
    const mode = await getApi().getTheme();
    const resolved = mode === 'system' ? resolveSystem() : mode;
    set({ mode, resolved });
    get().applyToDom();
  },

  setMode: async (mode) => {
    await getApi().setTheme(mode);
    const resolved = mode === 'system' ? resolveSystem() : mode;
    set({ mode, resolved });
    get().applyToDom();
  },

  applyToDom: () => {
    // Mantine colorScheme：设置 documentElement 的 attribute + 原生 color-scheme，
    // Mantine 的 CSS 变量（--mantine-color-*）与浏览器原生控件（滚动条/输入框）都跟随
    const { resolved } = get();
    document.documentElement.setAttribute('data-mantine-color-scheme', resolved);
    document.documentElement.style.colorScheme = resolved;
  },
}));
