import { useState } from 'react';
import { Drawer, Badge, Text, Button, Group, ScrollArea, Modal } from '@mantine/core';
import { IconTrash, IconCopy } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useWorkspaceStore } from '@/store/useWorkspaceStore';
import type { SavedQuery } from '@/types';

interface Props {
  visible: boolean;
  onClose: () => void;
}

/**
 * 收藏查询抽屉：展示当前连接下用户主动保存的查询语句。
 * 点击项 → 打开到新查询 tab；每项可复制 SQL / 删除。
 */
export function SavedQueries({ visible, onClose }: Props) {
  const savedQueries = useWorkspaceStore((s) => s.savedQueries);
  const removeSavedQuery = useWorkspaceStore((s) => s.removeSavedQuery);
  const openQuery = useWorkspaceStore((s) => s.openQuery);
  const [deleteTarget, setDeleteTarget] = useState<SavedQuery | null>(null);

  return (
    <>
      <Drawer opened={visible} onClose={onClose} title="收藏查询" size={520} position="right">
        {savedQueries.length === 0 ? (
          <Text c="dimmed" ta="center" py={40}>
            暂无收藏，可在查询编辑器工具栏点击「收藏」保存常用查询
          </Text>
        ) : (
          <ScrollArea style={{ height: 'calc(100vh - 120px)' }}>
            {savedQueries.map((item) => (
              <div
                key={item.id}
                style={{
                  padding: '10px 12px',
                  borderRadius: 6,
                  borderBottom: '1px solid var(--iv-border-light)',
                }}
              >
                <Group justify="space-between" mb={4} wrap="nowrap">
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm" fw={600}>{item.title}</Text>
                    {item.database && <Badge size="xs" variant="outline">{item.database}</Badge>}
                  </Group>
                  <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                    {new Date(item.createdAt).toLocaleString()}
                  </Text>
                </Group>
                <Text
                  size="xs"
                  style={{ fontFamily: 'monospace', color: 'var(--iv-text-2)', cursor: 'pointer', margin: 0 }}
                  onClick={() => {
                    openQuery(item.sql, item.database);
                    onClose();
                  }}
                >
                  {item.sql}
                </Text>
                <Group justify="flex-end" gap={4} mt={6}>
                  <Button
                    variant="subtle"
                    size="compact-xs"
                    leftSection={<IconCopy size={12} />}
                    onClick={() => {
                      void navigator.clipboard.writeText(item.sql).then(() => notifications.show({ message: '已复制 SQL' }));
                    }}
                  >
                    复制
                  </Button>
                  <Button
                    variant="subtle"
                    size="compact-xs"
                    color="red"
                    leftSection={<IconTrash size={12} />}
                    onClick={() => setDeleteTarget(item)}
                  >
                    删除
                  </Button>
                </Group>
              </div>
            ))}
          </ScrollArea>
        )}
      </Drawer>

      {/* 删除确认 */}
      <Modal opened={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="删除收藏" size="sm">
        <Text size="sm" mb="lg">
          确定删除收藏「{deleteTarget?.title}」？
        </Text>
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={() => setDeleteTarget(null)}>
            取消
          </Button>
          <Button
            color="red"
            leftSection={<IconTrash size={14} />}
            onClick={() => {
              if (deleteTarget) removeSavedQuery(deleteTarget.id);
              setDeleteTarget(null);
            }}
          >
            删除
          </Button>
        </Group>
      </Modal>
    </>
  );
}
