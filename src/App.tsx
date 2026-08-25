import { Component, type ErrorInfo, type ReactNode, useEffect, useState, useCallback } from 'react';
import { ConnectionBar } from '@/components/ConnectionBar';
import { Sidebar } from '@/components/Sidebar';
import { Workspace } from '@/components/Workspace';
import { ErrorDialog, reportError } from '@/components/ErrorDialog';
import { TitleBar } from '@/components/TitleBar';
import { ContextMenu } from '@/components/ContextMenu';
import { UpdateModal } from '@/components/UpdateModal';
import { useAutoUpdateCheck } from '@/hooks/useAutoUpdateCheck';

/** 捕获子树渲染错误，上报到全局 ErrorDialog（自定义弹窗），避免白屏 */
class ErrorBoundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state: { crashed: boolean } = { crashed: false };
  static getDerivedStateFromError() {
    return { crashed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(
      '渲染出错',
      error.message,
      `${error.stack || ''}\n\n组件栈：\n${info.componentStack || ''}`,
    );
  }
  render() {
    if (this.state.crashed) {
      // 不渲染内联错误，由全局 ErrorDialog 弹窗显示；这里只占位避免重复崩溃
      return <div style={{ flex: 1 }} />;
    }
    return this.props.children;
  }
}

export default function App() {
  const [updateOpen, setUpdateOpen] = useState(false);
  const openUpdate = useCallback(() => setUpdateOpen(true), []);

  // 启动时静默检查更新（仅生产环境）；顶栏按钮经自定义事件打开同一弹窗
  useAutoUpdateCheck(openUpdate);
  useEffect(() => {
    window.addEventListener('iv:open-update', openUpdate as EventListener);
    return () => window.removeEventListener('iv:open-update', openUpdate as EventListener);
  }, [openUpdate]);

  return (
    <>
      {/* 全局错误弹窗：放在 ErrorBoundary 外面，确保子树崩溃时弹窗仍能渲染 */}
      <ErrorDialog />
      {/* 检查更新弹窗（全局唯一） */}
      <UpdateModal opened={updateOpen} onClose={() => setUpdateOpen(false)} />
      {/* 全局右键菜单 Portal：独立于业务组件树，显隐不触发表格/编辑器重渲染 */}
      <ContextMenu />
      <ErrorBoundary>
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--iv-bg-app)' }}>
          {/* 自绘标题栏：拖拽 + 窗口控制按钮（替代系统标题栏） */}
          <TitleBar />
          <ConnectionBar />
          <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
            <aside
              style={{
                width: 'var(--iv-sidebar-width)',
                flexShrink: 0,
                borderRight: '1px solid var(--iv-border)',
              }}
            >
              <Sidebar />
            </aside>
            <main style={{ flex: 1, minWidth: 0, background: 'var(--iv-bg-elevated)' }}>
              <Workspace />
            </main>
          </div>
        </div>
      </ErrorBoundary>
    </>
  );
}
