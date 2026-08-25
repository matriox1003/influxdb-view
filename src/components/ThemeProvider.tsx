import { useEffect, type ReactNode } from 'react';
import { useMantineColorScheme } from '@mantine/core';
import { useThemeStore } from '@/store/useThemeStore';

/** 主题 Provider：加载持久化主题、同步 Mantine colorScheme、监听系统主题变化 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const load = useThemeStore((s) => s.load);
  const resolved = useThemeStore((s) => s.resolved);
  const { setColorScheme } = useMantineColorScheme();

  // 启动时加载持久化主题（store 内会 applyToDom + 更新 resolved）
  useEffect(() => {
    void load();
    // 监听系统主题变化（当 mode=system 时联动）
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      const { mode } = useThemeStore.getState();
      if (mode === 'system') {
        useThemeStore.setState({ resolved: mq.matches ? 'dark' : 'light' });
        useThemeStore.getState().applyToDom();
      }
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [load]);

  // store 的 resolved 变化 → 同步 MantineProvider 的 colorScheme
  useEffect(() => {
    setColorScheme(resolved);
  }, [resolved, setColorScheme]);

  return <>{children}</>;
}
