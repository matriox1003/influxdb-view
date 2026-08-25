import React from 'react';
import ReactDOM from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import 'mantine-react-table/styles.css';
import './styles/global.css';
import App from './App';
import { ThemeProvider } from '@/components/ThemeProvider';
import { theme } from '@/theme';

const rootEl = document.getElementById('root')!;

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="light">
      <Notifications position="top-right" />
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </MantineProvider>
  </React.StrictMode>,
);

// ─── 启动遮罩淡出 ───
// 遮罩在 index.html 里为纯静态 HTML/CSS，首帧即可见（覆盖启动空白阶段）。
// 这里等 React 真正挂载（#root 有内容）后再淡出，确保遮罩贯穿加载过程；
// 并设置最短展示时长，避免冷启动过快时遮罩一闪而过、看起来像闪屏。
const splashStart = performance.now();

const hideSplash = () => {
  const splash = document.getElementById('app-splash');
  if (!splash) return;
  splash.classList.add('iv-splash-hide');
  // transitionend 后移除节点；超时兜底，避免 transitionend 在某些情况下不触发
  splash.addEventListener('transitionend', () => splash.remove(), { once: true });
  setTimeout(() => splash.remove(), 800);
};

const hideWhenReady = () => {
  const elapsed = performance.now() - splashStart;
  // 保证最短展示 450ms，让品牌遮罩有存在感
  setTimeout(hideSplash, Math.max(0, 450 - elapsed));
};

const observer = new MutationObserver(() => {
  if (rootEl.childNodes.length > 0) {
    observer.disconnect();
    hideWhenReady();
  }
});
observer.observe(rootEl, { childList: true });
// 兜底：即便观察失效（如渲染异常），也确保遮罩不会永久挡住界面
setTimeout(() => {
  observer.disconnect();
  hideSplash();
}, 8000);
