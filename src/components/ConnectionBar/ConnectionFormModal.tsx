import { useEffect, useState } from 'react';
import { Modal, TextInput, NumberInput, PasswordInput, Switch, Button, Group } from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconDeviceFloppy, IconPlugConnected } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import type { ConnectionConfig, ConnectionForm } from '@/types';
import { getApi } from '@/types';

interface Props {
  visible: boolean;
  /** 编辑模式时传入的连接；新建时为 null */
  editing: ConnectionConfig | null;
  onCancel: () => void;
  onSaved: () => void;
}

const EMPTY: ConnectionForm = {
  name: '',
  host: 'localhost',
  port: 8086,
  username: '',
  password: '',
  database: '',
  tls: false,
};

export function ConnectionFormModal({ visible, editing, onCancel, onSaved }: Props) {
  const [testing, setTesting] = useState(false);
  const form = useForm<ConnectionForm>({
    initialValues: EMPTY,
    validate: {
      name: (v) => (v.trim() ? null : '请输入连接名称'),
      host: (v) => (v.trim() ? null : '请输入主机地址'),
      port: (v) => (v ? null : '请输入端口'),
    },
  });

  useEffect(() => {
    if (!visible) return;
    form.setValues(
      editing
        ? {
            name: editing.name,
            host: editing.host,
            port: editing.port,
            username: editing.username || '',
            password: '',
            database: editing.database || '',
            tls: editing.tls,
          }
        : EMPTY,
    );
    form.clearErrors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, editing]);

  const handleTest = async () => {
    if (form.validate().hasErrors) return;
    setTesting(true);
    try {
      const res = await getApi().testConnection(form.values);
      notifications.show({ message: `连接成功！InfluxDB 版本：${res.version}（${res.latencyMs}ms）` });
    } catch (err) {
      notifications.show({ color: 'red', message: `连接失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = form.onSubmit(async (values) => {
    try {
      // 编辑时若密码留空，后端会保留原密码
      await getApi().saveConnection({ ...values, id: editing?.id });
      notifications.show({ message: editing ? '连接已更新' : '连接已创建' });
      onSaved();
    } catch (err) {
      notifications.show({ color: 'red', message: `保存失败：${err instanceof Error ? err.message : String(err)}` });
    }
  });

  return (
    <Modal opened={visible} onClose={onCancel} title={editing ? '编辑连接' : '新建连接'} size="md">
      <form onSubmit={handleSave}>
        <TextInput
          label="连接名称"
          placeholder="例如：本地测试库"
          required
          mb="sm"
          {...form.getInputProps('name')}
        />
        <TextInput
          label="主机地址"
          placeholder="localhost 或 IP / 域名"
          required
          mb="sm"
          {...form.getInputProps('host')}
        />
        <NumberInput
          label="端口"
          min={1}
          max={65535}
          required
          mb="sm"
          {...form.getInputProps('port')}
        />
        <TextInput
          label="用户名"
          placeholder="（可选）InfluxDB 用户名"
          mb="sm"
          {...form.getInputProps('username')}
        />
        <PasswordInput
          label={editing ? '密码（留空保留原密码）' : '密码'}
          placeholder="（可选）"
          autoComplete="off"
          mb="sm"
          {...form.getInputProps('password')}
        />
        <TextInput
          label="默认数据库"
          placeholder="（可选）查询时默认使用的库"
          mb="sm"
          {...form.getInputProps('database')}
        />
        <Switch
          label="启用 HTTPS (TLS)"
          mb="lg"
          {...form.getInputProps('tls', { type: 'checkbox' })}
        />
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onCancel}>
            取消
          </Button>
          <Button
            variant="default"
            leftSection={<IconPlugConnected size={14} />}
            loading={testing}
            onClick={handleTest}
          >
            测试连接
          </Button>
          <Button type="submit" leftSection={<IconDeviceFloppy size={14} />}>
            保存
          </Button>
        </Group>
      </form>
    </Modal>
  );
}
