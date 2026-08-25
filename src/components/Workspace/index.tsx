import { useEffect, useMemo, useRef, memo } from 'react';
import { Tabs, Button, Tooltip } from '@mantine/core';
import { IconPlus, IconX } from '@tabler/icons-react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkspaceStore } from '@/store/useWorkspaceStore';
import { useConnectionStore } from '@/store/useConnectionStore';
import { QueryEditor } from '@/components/QueryEditor';
import { AdminPanel } from '@/components/AdminPanel';
import { DataManager } from '@/components/DataManager';
import { QueryHistory } from '@/components/QueryEditor/QueryHistory';
import { SavedQueries } from '@/components/QueryEditor/SavedQueries';

function EmptyState() {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--iv-bg-elevated)',
        color: 'var(--iv-text-3)',
        gap: 12,
      }}
    >
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: 16,
          background: 'var(--iv-bg-panel)',
          border: '1px solid var(--iv-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 28,
          color: 'var(--iv-text-3)',
        }}
      >
        ⊞
      </div>
      <div style={{ fontSize: 14, color: 'var(--iv-text-2)' }}>尚未连接到数据库</div>
      <div style={{ fontSize: 12 }}>请在顶部选择已有连接，或点击 + 新建连接</div>
    </div>
  );
}

const TabContent = memo(function TabContent({ tab }: { tab: { id: string; title: string } }) {
  if (tab.title.startsWith('__admin__')) {
    return <AdminPanel onClose={() => useWorkspaceStore.getState().closeTab(tab.id)} />;
  }
  if (tab.title.startsWith('__write__')) {
    return <DataManager onClose={() => useWorkspaceStore.getState().closeTab(tab.id)} />;
  }
  return <QueryEditor tabId={tab.id} />;
});

/**
 * 标签页区域：只订阅 tabs / activeTabId，不关心 historyVisible。
 * 拆分为独立组件后，抽屉开关不会触发此子树重渲染。
 */
function WorkspaceTabs() {
  // 只订阅 id + title，不订阅 sql —— 避免每次按键都触发整个标签页树重渲染
  const tabs = useWorkspaceStore(useShallow((s) => s.tabs.map((t) => ({ id: t.id, title: t.title }))));
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const newQuery = useWorkspaceStore((s) => s.newQuery);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const activeConn = useConnectionStore((s) => s.connections.find((c) => c.id === s.activeId));

  const handleNewQuery = () => {
    newQuery(activeConn?.database);
  };

  return (
    <Tabs
      value={activeTabId || undefined}
      onChange={(key) => {
        if (key) setActive(key);
      }}
      className="iv-tabs-fill"
      keepMounted
    >
      <Tabs.List px="sm" pt={6} style={{ borderBottom: '1px solid var(--iv-border)' }}>
        {tabs.map((tab) => (
          <Tabs.Tab
            key={tab.id}
            value={tab.id}
            rightSection={
              <span
                role="button"
                aria-label="关闭标签页"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                style={{
                  display: 'inline-flex',
                  opacity: 0.5,
                  cursor: 'pointer',
                  marginLeft: 4,
                }}
              >
                <IconX size={12} />
              </span>
            }
          >
            {tab.title.startsWith('__admin__')
              ? '管理'
              : tab.title.startsWith('__write__')
                ? '数据写入'
                : tab.title}
          </Tabs.Tab>
        ))}
        <Tabs.Tab value="__new__" style={{ paddingInline: 8 }}>
          <Tooltip label="新建查询 (Ctrl+Enter 执行)">
            <span
              role="button"
              aria-label="新建查询"
              onClick={handleNewQuery}
              style={{ display: 'inline-flex', cursor: 'pointer' }}
            >
              <IconPlus size={14} />
            </span>
          </Tooltip>
        </Tabs.Tab>
      </Tabs.List>
      {tabs.map((tab) => (
        <Tabs.Panel key={tab.id} value={tab.id} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <TabContent tab={tab} />
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}

// ═══════════════════════════════════════════════════════════
// 主工作区：只订阅 historyVisible，Tabs 子树不随抽屉开关重渲染
// ═══════════════════════════════════════════════════════════
export function Workspace() {
  const historyVisible = useWorkspaceStore((s) => s.historyVisible);
  const setHistoryVisible = useWorkspaceStore((s) => s.setHistoryVisible);
  const savedVisible = useWorkspaceStore((s) => s.savedVisible);
  const setSavedVisible = useWorkspaceStore((s) => s.setSavedVisible);
  const activeConn = useConnectionStore((s) => s.connections.find((c) => c.id === s.activeId));

  // 连接就绪时确保至少有一个查询 tab。
  // 用 ref 记录上次初始化的连接 id，配合 store 的幂等 ensureQueryTab，
  // 双重保证 StrictMode 双调用 / 连接切换都只创建一个初始 tab。
  const initializedForConn = useRef<string | null>(null);
  useEffect(() => {
    if (!activeConn?.id) {
      initializedForConn.current = null;
      return;
    }
    // store 层已幂等（已有 tab 不创建），这里再按连接去重，
    // 避免切回旧连接时因 tabs 已清空又新建。
    useWorkspaceStore.getState().ensureQueryTab(activeConn.database);
    // 拉取该连接的收藏查询（连接切换时刷新为各自的列表）
    useWorkspaceStore.getState().loadSavedQueries(activeConn.id);
    initializedForConn.current = activeConn.id;
  }, [activeConn?.id, activeConn?.database]);

  // WorkspaceTabs 通过自身 selector 订阅 store，无需父级重渲染触发更新。
  // useMemo 固定其 ReactElement 引用，Workspace 重渲染时 React reconciliation 直接跳过该子树。
  const tabsElement = useMemo(() => <WorkspaceTabs />, []);

  if (!activeConn?.id) {
    return <EmptyState />;
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%' }}>
      {tabsElement}
      <QueryHistory visible={historyVisible} onClose={() => setHistoryVisible(false)} />
      <SavedQueries visible={savedVisible} onClose={() => setSavedVisible(false)} />
    </div>
  );
}
