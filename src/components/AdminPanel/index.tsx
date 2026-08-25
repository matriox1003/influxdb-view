import { useEffect, useState } from 'react';
import {
  Tabs,
  Table,
  Button,
  Group,
  Modal,
  TextInput,
  Switch,
  Text,
  Alert,
  Stack,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconRefresh, IconPlus, IconTrash } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useConnectionStore } from '@/store/useConnectionStore';
import { getApi } from '@/types';
import type { InfluxSeries } from '@/types';

interface Props {
  onClose: () => void;
}

function seriesToRows(series: InfluxSeries | undefined): Record<string, string>[] {
  if (!series) return [];
  return (series.values || []).map((row) => {
    const obj: Record<string, string> = {};
    series.columns.forEach((c, i) => (obj[c] = String(row[i])));
    return obj;
  });
}

/** 简单数据表格（AdminPanel 用，数据量小无需虚拟化） */
function SimpleTable({ rows, opColumn }: { rows: Record<string, string>[]; opColumn?: (row: Record<string, string>) => React.ReactNode }) {
  const cols = Object.keys(rows[0] || {});
  return (
    <Table striped highlightOnHover verticalSpacing="xs" horizontalSpacing="xs" style={{ tableLayout: 'fixed' }}>
      <Table.Thead>
        <Table.Tr>
          {cols.map((c) => (
            <Table.Th key={c} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c}
            </Table.Th>
          ))}
          {opColumn && <Table.Th style={{ width: 80 }}>操作</Table.Th>}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((r, i) => (
          <Table.Tr key={i}>
            {cols.map((c) => (
              <Table.Td
                key={c}
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: c === 'query' ? 400 : undefined,
                }}
                title={r[c]}
              >
                {r[c]}
              </Table.Td>
            ))}
            {opColumn && <Table.Td>{opColumn(r)}</Table.Td>}
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

export function AdminPanel({ onClose }: Props) {
  const activeConn = useConnectionStore((s) => s.connections.find((c) => c.id === s.activeId));
  const [tab, setTab] = useState('db');
  const [dbRows, setDbRows] = useState<Record<string, string>[]>([]);
  const [rpRows, setRpRows] = useState<Record<string, string>[]>([]);
  const [cqRows, setCqRows] = useState<Record<string, string>[]>([]);
  const [userRows, setUserRows] = useState<Record<string, string>[]>([]);
  const [loading, setLoading] = useState(false);
  const [dbForRp, setDbForRp] = useState<string>('');
  /** 当前 Tab 的查询错误（如权限不足），在表格区展示而非弹全局错误框 */
  const [tabError, setTabError] = useState<string | null>(null);

  // 新建 DB / User 弹窗
  const [newDbVisible, setNewDbVisible] = useState(false);
  const [newUserVisible, setNewUserVisible] = useState(false);
  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<{ kind: 'db' | 'user'; name: string } | null>(null);

  const exec = async (q: string, db?: string): Promise<boolean> => {
    if (!activeConn?.id) return false;
    try {
      await getApi().query({ connectionId: activeConn.id, database: db, query: q });
      notifications.show({ message: '执行成功' });
      return true;
    } catch (err) {
      notifications.show({ color: 'red', message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  };

  const refreshDbs = async () => {
    if (!activeConn?.id) return;
    setLoading(true);
    setTabError(null);
    try {
      const res = await getApi().query({ connectionId: activeConn.id, query: 'SHOW DATABASES' });
      setDbRows(seriesToRows(res.results?.[0]?.series?.[0]));
    } catch (err) {
      setTabError(err instanceof Error ? err.message : String(err));
      setDbRows([]);
    } finally {
      setLoading(false);
    }
  };

  const refreshRps = async () => {
    if (!activeConn?.id || !dbForRp) return;
    setLoading(true);
    setTabError(null);
    try {
      const res = await getApi().query({
        connectionId: activeConn.id,
        database: dbForRp,
        query: 'SHOW RETENTION POLICIES',
      });
      setRpRows(seriesToRows(res.results?.[0]?.series?.[0]));
    } catch (err) {
      setTabError(err instanceof Error ? err.message : String(err));
      setRpRows([]);
    } finally {
      setLoading(false);
    }
  };

  const refreshCqs = async () => {
    if (!activeConn?.id) return;
    setLoading(true);
    setTabError(null);
    try {
      const res = await getApi().query({ connectionId: activeConn.id, query: 'SHOW CONTINUOUS QUERIES' });
      // CQ 返回多个 series，每个库名一个
      const all: Record<string, string>[] = [];
      (res.results?.[0]?.series || []).forEach((s) => {
        seriesToRows(s).forEach((r) => all.push({ database: s.name, ...r }));
      });
      setCqRows(all);
    } catch (err) {
      setTabError(err instanceof Error ? err.message : String(err));
      setCqRows([]);
    } finally {
      setLoading(false);
    }
  };

  const refreshUsers = async () => {
    if (!activeConn?.id) return;
    setLoading(true);
    setTabError(null);
    try {
      const res = await getApi().query({ connectionId: activeConn.id, query: 'SHOW USERS' });
      setUserRows(seriesToRows(res.results?.[0]?.series?.[0]));
    } catch (err) {
      setTabError(err instanceof Error ? err.message : String(err));
      setUserRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (activeConn?.id && tab === 'db') void refreshDbs();
    if (activeConn?.id && tab === 'user') void refreshUsers();
    if (activeConn?.id && tab === 'cq') void refreshCqs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConn?.id, tab]);

  if (!activeConn?.id) {
    return <Text c="dimmed" ta="center" py={60}>请先选择连接</Text>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px' }}>
        <Tabs
          value={tab}
          onChange={(key) => {
            if (key) {
              setTab(key);
              setTabError(null);
            }
          }}
        >
          <Tabs.List>
            <Tabs.Tab value="db">数据库</Tabs.Tab>
            <Tabs.Tab value="rp">保留策略</Tabs.Tab>
            <Tabs.Tab value="cq">连续查询</Tabs.Tab>
            <Tabs.Tab value="user">用户</Tabs.Tab>
          </Tabs.List>
        </Tabs>
        <Button variant="default" size="compact-sm" onClick={onClose}>
          关闭
        </Button>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '0 12px 12px' }}>
        {/* 查询错误（如权限不足）在表格区展示，避免弹全局错误框打断操作 */}
        {tabError && (
          <Alert
            color="red"
            variant="light"
            mb="sm"
            withCloseButton
            onClose={() => setTabError(null)}
          >
            {tabError}
          </Alert>
        )}
        {tab === 'db' && (
          <Stack gap="sm">
            <Group gap="sm">
              <Button size="xs" leftSection={<IconPlus size={13} />} onClick={() => setNewDbVisible(true)}>
                新建数据库
              </Button>
              <Button size="xs" variant="default" leftSection={<IconRefresh size={13} />} onClick={() => void refreshDbs()} loading={loading}>
                刷新
              </Button>
            </Group>
            <SimpleTable
              rows={dbRows}
              opColumn={(row) => (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="red"
                  leftSection={<IconTrash size={12} />}
                  onClick={() => setDeleteTarget({ kind: 'db', name: row.name })}
                >
                  删除
                </Button>
              )}
            />
          </Stack>
        )}

        {tab === 'rp' && (
          <Stack gap="sm">
            <Group gap="sm">
              <TextInput
                placeholder="输入数据库名查看其保留策略"
                value={dbForRp}
                onChange={(e) => setDbForRp(e.currentTarget.value)}
                size="xs"
                style={{ width: 240 }}
              />
              <Button size="xs" variant="default" leftSection={<IconRefresh size={13} />} onClick={() => void refreshRps()} loading={loading}>
                查询
              </Button>
            </Group>
            {rpRows.length > 0 ? (
              <SimpleTable rows={rpRows} />
            ) : (
              <Text c="dimmed" size="sm">输入数据库名后点击查询</Text>
            )}
          </Stack>
        )}

        {tab === 'cq' && (
          <Stack gap="sm">
            <Button size="xs" variant="default" leftSection={<IconRefresh size={13} />} onClick={() => void refreshCqs()} loading={loading} style={{ alignSelf: 'flex-start' }}>
              刷新
            </Button>
            {cqRows.length > 0 ? (
              <SimpleTable rows={cqRows} />
            ) : (
              <Text c="dimmed" size="sm">暂无连续查询</Text>
            )}
          </Stack>
        )}

        {tab === 'user' && (
          <Stack gap="sm">
            <Group gap="sm">
              <Button size="xs" leftSection={<IconPlus size={13} />} onClick={() => setNewUserVisible(true)}>
                新建用户
              </Button>
              <Button size="xs" variant="default" leftSection={<IconRefresh size={13} />} onClick={() => void refreshUsers()} loading={loading}>
                刷新
              </Button>
            </Group>
            <SimpleTable
              rows={userRows}
              opColumn={(row) => (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="red"
                  leftSection={<IconTrash size={12} />}
                  onClick={() => setDeleteTarget({ kind: 'user', name: row.user })}
                >
                  删除
                </Button>
              )}
            />
          </Stack>
        )}
      </div>

      {/* 新建数据库弹窗 */}
      <NewDbModal
        visible={newDbVisible}
        onCancel={() => setNewDbVisible(false)}
        onOk={async (name) => {
          if (await exec(`CREATE DATABASE "${name}"`)) {
            setNewDbVisible(false);
            void refreshDbs();
          }
        }}
      />
      {/* 新建用户弹窗 */}
      <NewUserModal
        visible={newUserVisible}
        onCancel={() => setNewUserVisible(false)}
        onOk={async (name, pwd, admin) => {
          if (
            await exec(
              `CREATE USER "${name}" WITH PASSWORD '${pwd}'${admin ? ' WITH ALL PRIVILEGES' : ''}`,
            )
          ) {
            setNewUserVisible(false);
            void refreshUsers();
          }
        }}
      />
      {/* 删除确认 */}
      <Modal
        opened={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={`删除${deleteTarget?.kind === 'db' ? '数据库' : '用户'}`}
        size="sm"
      >
        <Text size="sm" mb="lg">
          删除{deleteTarget?.kind === 'db' ? '数据库' : '用户'}「{deleteTarget?.name}」？此操作不可恢复！
        </Text>
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={() => setDeleteTarget(null)}>
            取消
          </Button>
          <Button
            color="red"
            leftSection={<IconTrash size={14} />}
            onClick={async () => {
              if (!deleteTarget) return;
              if (deleteTarget.kind === 'db') {
                if (await exec(`DROP DATABASE "${deleteTarget.name}"`)) void refreshDbs();
              } else {
                if (await exec(`DROP USER "${deleteTarget.name}"`)) void refreshUsers();
              }
              setDeleteTarget(null);
            }}
          >
            删除
          </Button>
        </Group>
      </Modal>
    </div>
  );
}

function NewDbModal({
  visible,
  onCancel,
  onOk,
}: {
  visible: boolean;
  onCancel: () => void;
  onOk: (name: string) => Promise<void>;
}) {
  const form = useForm({ initialValues: { name: '' }, validate: { name: (v) => (v.trim() ? null : '请输入数据库名') } });
  return (
    <Modal opened={visible} onClose={onCancel} title="新建数据库" size="sm">
      <form
        onSubmit={form.onSubmit(async (values) => {
          await onOk(values.name.trim());
        })}
      >
        <TextInput
          label="数据库名"
          placeholder="例如：mydb"
          required
          mb="lg"
          {...form.getInputProps('name')}
        />
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onCancel}>取消</Button>
          <Button type="submit">创建</Button>
        </Group>
      </form>
    </Modal>
  );
}

function NewUserModal({
  visible,
  onCancel,
  onOk,
}: {
  visible: boolean;
  onCancel: () => void;
  onOk: (name: string, pwd: string, admin: boolean) => Promise<void>;
}) {
  const form = useForm({
    initialValues: { name: '', password: '', admin: false },
    validate: {
      name: (v) => (v.trim() ? null : '请输入用户名'),
      password: (v) => (v.trim() ? null : '请输入密码'),
    },
  });
  return (
    <Modal opened={visible} onClose={onCancel} title="新建用户" size="sm">
      <form
        onSubmit={form.onSubmit(async (values) => {
          await onOk(values.name.trim(), values.password, !!values.admin);
        })}
      >
        <TextInput label="用户名" required mb="sm" {...form.getInputProps('name')} />
        <TextInput label="密码" type="password" required mb="sm" {...form.getInputProps('password')} />
        <Switch label="是否管理员" mb="lg" {...form.getInputProps('admin', { type: 'checkbox' })} />
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onCancel}>取消</Button>
          <Button type="submit">创建</Button>
        </Group>
      </form>
    </Modal>
  );
}
