import { useEffect } from 'react';
import { Button, Tooltip, SegmentedControl, Menu } from '@mantine/core';
import {
  IconMoon,
  IconSun,
  IconDeviceDesktop,
  IconSettings,
  IconUpload,
  IconDatabase,
  IconRefresh,
  IconCheck,
  IconChevronDown,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useConnectionStore } from '@/store/useConnectionStore';
import { useThemeStore } from '@/store/useThemeStore';
import { useWorkspaceStore } from '@/store/useWorkspaceStore';
import { useDatabaseStore } from '@/store/useDatabaseStore';
import { ConnectionManager } from './ConnectionManager';
import { getUpdaterApi } from '@/types';
import { useState } from 'react';

export function ConnectionBar() {
  // 精确订阅：只挑用到的字段，连接库其他变化（如保存表单中间态）不再重渲染顶栏
  const connections = useConnectionStore((s) => s.connections);
  const activeId = useConnectionStore((s) => s.activeId);
  const load = useConnectionStore((s) => s.load);
  const activeConn = connections.find((c) => c.id === activeId);
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);
  const openAdmin = useWorkspaceStore((s) => s.openAdmin);
  const openWrite = useWorkspaceStore((s) => s.openWrite);
  const [managerVisible, setManagerVisible] = useState(false);
  const [appVersion, setAppVersion] = useState('');

  // 当前应用版本号（主进程 app.getVersion()），设置菜单显示用
  useEffect(() => {
    const api = getUpdaterApi();
    if (!api) return;
    api
      .getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRefresh = async () => {
    if (activeId) {
      await load();
      // 强制刷新数据库列表缓存
      void useDatabaseStore.getState().load(activeId, true);
      notifications.show({ message: '已刷新' });
    }
  };

  return (
    <>
      <header className="iv-toolbar" style={{ gap: 10 }}>
        {/* 醒目的大「连接」按钮：点击弹出连接管理窗口 */}
        <Button
          variant={activeConn ? 'outline' : 'filled'}
          leftSection={<IconDatabase size={15} />}
          onClick={() => setManagerVisible(true)}
          style={{ height: 30, borderRadius: 6, fontWeight: 500 }}
        >
          连接
        </Button>

        {/* 当前连接状态显示 */}
        {activeConn ? (
          <Tooltip label="点击「连接」可切换或管理连接">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                borderRadius: 6,
                background: 'var(--iv-bg-app)',
                border: '1px solid var(--iv-border-light)',
                cursor: 'default',
                maxWidth: 320,
                height: 30,
              }}
            >
              <IconCheck size={13} style={{ color: 'var(--mantine-color-green-6)', flexShrink: 0 }} />
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {activeConn.name}
              </span>
              <span style={{ fontSize: 12, color: 'var(--iv-text-3)' }}>
                · {activeConn.host}:{activeConn.port}
              </span>
            </div>
          </Tooltip>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--iv-text-3)' }}>尚未连接</span>
        )}

        {/* 分隔线 */}
        <div style={{ width: 1, height: 20, background: 'var(--iv-border)', margin: '0 2px' }} />

        {/* 工具组：刷新 / 管理 / 写入 */}
        <div style={{ display: 'flex', gap: 2 }}>
          <Tooltip label="刷新连接">
            <Button variant="subtle" size="compact-sm" aria-label="刷新连接" onClick={() => void handleRefresh()} disabled={!activeId}>
              <IconRefresh size={15} />
            </Button>
          </Tooltip>
          <Tooltip label="数据库管理">
            <Button variant="subtle" size="compact-sm" aria-label="数据库管理" onClick={openAdmin} disabled={!activeId}>
              <IconSettings size={15} />
            </Button>
          </Tooltip>
          <Tooltip label="数据写入">
            <Button variant="subtle" size="compact-sm" aria-label="数据写入" onClick={openWrite} disabled={!activeId}>
              <IconUpload size={15} />
            </Button>
          </Tooltip>
        </div>

        <div style={{ flex: 1 }} />

        {/* 设置菜单：版本信息 + 检查更新 */}
        <Menu shadow="md" width={220} position="bottom-end" withinPortal>
          <Menu.Target>
            <Button variant="subtle" size="compact-sm" rightSection={<IconChevronDown size={12} />}>
              设置
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>{appVersion ? `v${appVersion}` : '版本'}</Menu.Label>
            <Menu.Item onClick={() => window.dispatchEvent(new CustomEvent('iv:open-update'))}>
              检查更新
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>

        {/* 主题切换（黑白主题三态） */}
        <SegmentedControl
          size="xs"
          value={themeMode}
          onChange={(v) => void setThemeMode(v as 'light' | 'dark' | 'system')}
          data={[
            { value: 'light', label: <IconSun size={14} /> },
            { value: 'system', label: <IconDeviceDesktop size={14} /> },
            { value: 'dark', label: <IconMoon size={14} /> },
          ]}
        />
      </header>

      {/* 连接管理弹窗 */}
      <ConnectionManager visible={managerVisible} onClose={() => setManagerVisible(false)} />
    </>
  );
}
