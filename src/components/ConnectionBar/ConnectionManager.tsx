import { useEffect, useState } from 'react';
import { Modal, Button, Group, Text } from '@mantine/core';
import {
  IconPlus,
  IconEdit,
  IconTrash,
  IconPlug,
  IconDatabase,
  IconCheck,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useConnectionStore } from '@/store/useConnectionStore';
import { getApi } from '@/types';
import type { ConnectionConfig } from '@/types';
import { ConnectionFormModal } from './ConnectionFormModal';

interface Props {
  visible: boolean;
  onClose: () => void;
}

/**
 * 连接管理弹窗：类似 Navicat 的连接列表。
 * 卡片形式展示所有已配置的连接，支持双击/按钮 连接、新建、编辑、删除。
 */
export function ConnectionManager({ visible, onClose }: Props) {
  const { connections, activeId, setActive, load } = useConnectionStore();
  const [formVisible, setFormVisible] = useState(false);
  const [editing, setEditing] = useState<ConnectionConfig | null>(null);
  // 删除确认的目标连接（Mantine 无 Popconfirm，用小确认弹窗）
  const [deleteTarget, setDeleteTarget] = useState<ConnectionConfig | null>(null);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  const handleNew = () => {
    setEditing(null);
    setFormVisible(true);
  };

  const handleEdit = (conn: ConnectionConfig) => {
    setEditing(conn);
    setFormVisible(true);
  };

  const handleDelete = async (id: string) => {
    await getApi().deleteConnection(id);
    if (activeId === id) setActive(null);
    await load();
    setDeleteTarget(null);
    notifications.show({ message: '已删除' });
  };

  const handleConnect = (conn: ConnectionConfig) => {
    setActive(conn.id);
    onClose();
    notifications.show({ message: `已连接到 ${conn.name}` });
  };

  return (
    <>
      <Modal
        opened={visible}
        onClose={onClose}
        title={
          <Group gap={8} wrap="nowrap">
            <IconDatabase size={18} style={{ color: 'var(--mantine-primary-color-filled)' }} />
            <span>连接管理</span>
            <Text size="xs" c="dimmed" fw={400}>
              共 {connections.length} 个连接
            </Text>
          </Group>
        }
        size="xl"
      >
        {/* 工具栏 */}
        <Group justify="space-between" mb="md">
          <Text size="xs" c="dimmed">
            双击卡片或点击「连接」即可连入
          </Text>
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={handleNew}>
            新建连接
          </Button>
        </Group>

        {/* 连接卡片列表 */}
        {connections.length === 0 ? (
          <Text c="dimmed" ta="center" py={60}>
            还没有连接，点击「新建连接」开始
          </Text>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 12,
              maxHeight: 420,
              overflow: 'auto',
              padding: 2,
            }}
          >
            {connections.map((conn) => {
              const isActive = conn.id === activeId;
              return (
                <div
                  key={conn.id}
                  onDoubleClick={() => handleConnect(conn)}
                  style={{
                    border: isActive
                      ? '1px solid var(--mantine-primary-color-filled)'
                      : '1px solid var(--iv-border)',
                    borderRadius: 8,
                    padding: 14,
                    background: isActive ? 'var(--mantine-color-gray-0)' : 'var(--iv-bg-elevated)',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                    position: 'relative',
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.borderColor = 'var(--mantine-color-gray-4)';
                      e.currentTarget.style.background = 'var(--mantine-color-gray-0)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.borderColor = 'var(--iv-border)';
                      e.currentTarget.style.background = 'var(--iv-bg-elevated)';
                    }
                  }}
                >
                  {/* 已连接标识 */}
                  {isActive && (
                    <IconCheck
                      size={16}
                      style={{
                        position: 'absolute',
                        top: 10,
                        right: 10,
                        color: 'var(--mantine-color-green-6)',
                      }}
                    />
                  )}

                  {/* 头部：图标 + 名称 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                    <div
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 8,
                        background: isActive
                          ? 'var(--mantine-primary-color-filled)'
                          : 'var(--mantine-color-gray-2)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: isActive ? '#fff' : 'var(--iv-text-2)',
                        flexShrink: 0,
                      }}
                    >
                      <IconDatabase size={18} />
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 14,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {conn.name}
                      </div>
                      <Text size="xs" c="dimmed">
                        {conn.tls ? 'https' : 'http'} · {conn.host}:{conn.port}
                      </Text>
                    </div>
                  </div>

                  {/* 详情 */}
                  <div style={{ fontSize: 12, color: 'var(--iv-text-3)', marginBottom: 12, lineHeight: 1.6 }}>
                    {conn.username ? <div>用户：{conn.username}</div> : <div>匿名访问</div>}
                    {conn.database && <div>默认库：{conn.database}</div>}
                  </div>

                  {/* 操作按钮 */}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Button
                      size="compact-sm"
                      variant={isActive ? 'default' : 'filled'}
                      leftSection={<IconPlug size={13} />}
                      onClick={() => handleConnect(conn)}
                    >
                      {isActive ? '已连接' : '连接'}
                    </Button>
                    <Button
                      size="compact-sm"
                      variant="subtle"
                      leftSection={<IconEdit size={13} />}
                      onClick={() => handleEdit(conn)}
                    >
                      编辑
                    </Button>
                    <Button
                      size="compact-sm"
                      variant="subtle"
                      color="red"
                      leftSection={<IconTrash size={13} />}
                      onClick={() => setDeleteTarget(conn)}
                    >
                      删除
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Modal>

      {/* 删除确认 */}
      <Modal
        opened={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="删除连接"
        size="sm"
      >
        <Text size="sm" mb="lg">
          确定删除连接「{deleteTarget?.name}」？此操作不可恢复！
        </Text>
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={() => setDeleteTarget(null)}>
            取消
          </Button>
          <Button color="red" leftSection={<IconTrash size={14} />} onClick={() => deleteTarget && handleDelete(deleteTarget.id)}>
            删除
          </Button>
        </Group>
      </Modal>

      {/* 新建/编辑连接表单 */}
      <ConnectionFormModal
        visible={formVisible}
        editing={editing}
        onCancel={() => setFormVisible(false)}
        onSaved={() => {
          setFormVisible(false);
          void load();
        }}
      />
    </>
  );
}
