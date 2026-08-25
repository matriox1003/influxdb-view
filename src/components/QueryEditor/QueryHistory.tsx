import { Drawer, Badge, Text, Button, Group, ScrollArea } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import { useWorkspaceStore } from '@/store/useWorkspaceStore';

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function QueryHistory({ visible, onClose }: Props) {
  const history = useWorkspaceStore((s) => s.history);
  const clearHistory = useWorkspaceStore((s) => s.clearHistory);
  const openQuery = useWorkspaceStore((s) => s.openQuery);

  return (
    <Drawer
      opened={visible}
      onClose={onClose}
      title="查询历史"
      size={520}
      position="right"
    >
      <Group justify="flex-end" mb="sm">
        {history.length > 0 && (
          <Button variant="subtle" size="compact-sm" leftSection={<IconTrash size={13} />} onClick={clearHistory} color="red">
            清空
          </Button>
        )}
      </Group>
      {history.length === 0 ? (
        <Text c="dimmed" ta="center" py={40}>
          暂无历史
        </Text>
      ) : (
        <ScrollArea style={{ height: 'calc(100vh - 120px)' }}>
          {history.map((item) => (
            <div
              key={item.id}
              style={{
                padding: '10px 12px',
                borderRadius: 6,
                cursor: 'pointer',
                borderBottom: '1px solid var(--iv-border-light)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--mantine-color-gray-0)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
              onClick={() => {
                openQuery(item.sql, item.database);
                onClose();
              }}
            >
              <Group justify="space-between" mb={4} wrap="nowrap">
                <Group gap={6} wrap="nowrap">
                  {item.ok ? (
                    <Badge color="green" variant="light" size="xs">成功</Badge>
                  ) : (
                    <Badge color="red" variant="light" size="xs">失败</Badge>
                  )}
                  {item.database && <Badge size="xs" variant="outline">{item.database}</Badge>}
                </Group>
                <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                  {new Date(item.at).toLocaleTimeString()}
                  {item.durationMs ? ` · ${item.durationMs}ms` : ''}
                </Text>
              </Group>
              <Text size="xs" style={{ fontFamily: 'monospace', margin: 0 }}>
                {item.sql}
              </Text>
            </div>
          ))}
        </ScrollArea>
      )}
    </Drawer>
  );
}
