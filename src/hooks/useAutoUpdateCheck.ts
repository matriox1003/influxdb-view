import { useEffect } from 'react';
import { notifications } from '@mantine/notifications';
import { getUpdaterApi } from '@/types';

/**
 * 启动时静默检查更新（仅生产环境构建）：
 * - 有新版本时弹一条可点击的通知，点击打开更新弹窗
 * - 无更新/检查失败完全静默（不打扰）
 * - 延迟 5s 执行，避开启动高峰
 */
export function useAutoUpdateCheck(onFound: () => void) {
  useEffect(() => {
    if (import.meta.env.DEV) return;
    const api = getUpdaterApi();
    if (!api) return;

    const timer = setTimeout(() => {
      api
        .check()
        .then((r) => {
          if (r.available && r.version) {
            notifications.show({
              message: `发现新版本 v${r.version}（当前 v${r.currentVersion}）`,
              autoClose: 10000,
              onClick: onFound,
            });
          }
        })
        .catch(() => {
          /* 静默 */
        });
    }, 5000);

    return () => clearTimeout(timer);
  }, [onFound]);
}
