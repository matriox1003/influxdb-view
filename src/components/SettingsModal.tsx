/**
 * 设置弹窗（目前含「网络代理」一节）。
 *
 * 代理三态：不使用代理 / 使用系统代理 / 自定义代理。
 * 保存后立即在主进程生效，同时覆盖两条网络通路：
 * - InfluxDB 连接（连接/查询/写入）
 * - 应用更新（检查更新 / 下载更新）
 * 本机与局域网地址默认直连（可勾选取消该行为），避免内网数据库被绕到代理上。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Divider,
  Group,
  Modal,
  NumberInput,
  PasswordInput,
  Radio,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconDeviceFloppy,
  IconInfoCircle,
  IconPlugConnected,
  IconRefresh,
  IconWorld,
} from '@tabler/icons-react';
import type { ProxyMode, ProxyProtocol, ProxySettingsInput, SystemProxyInfo } from '@/types';
import { getApi } from '@/types';

interface Props {
  opened: boolean;
  onClose: () => void;
}

const DEFAULTS: ProxySettingsInput = {
  mode: 'system',
  protocol: 'http',
  host: '127.0.0.1',
  port: 7890,
  username: '',
  password: '',
  bypass: '',
  proxyPrivateNetworks: false,
};

/** 三种代理模式的文案（顺序即展示顺序） */
const MODES: Array<{ value: ProxyMode; label: string; description: string }> = [
  {
    value: 'none',
    label: '不使用代理',
    description: '所有请求直连，忽略系统代理设置。',
  },
  {
    value: 'system',
    label: '使用系统代理',
    description: '跟随操作系统的代理配置，含 PAC 脚本。',
  },
  {
    value: 'custom',
    label: '自定义代理',
    description: '手动指定代理服务器（Clash / v2rayN 等）。',
  },
];

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function SettingsModal({ opened, onClose }: Props) {
  const [form, setForm] = useState<ProxySettingsInput>(DEFAULTS);
  /** 已保存过代理密码（不在渲染层回传明文，只回传这个标记） */
  const [hasPassword, setHasPassword] = useState(false);
  const [clearPassword, setClearPassword] = useState(false);
  const [systemProxy, setSystemProxy] = useState<SystemProxyInfo | null>(null);
  const [probingSystem, setProbingSystem] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const probeSystemProxy = useCallback(async () => {
    setProbingSystem(true);
    try {
      setSystemProxy(await getApi().getSystemProxy());
    } catch {
      setSystemProxy(null);
    } finally {
      setProbingSystem(false);
    }
  }, []);

  // 打开时读取已保存设置 + 探测系统代理
  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    void (async () => {
      try {
        const saved = await getApi().getProxySettings();
        if (cancelled) return;
        setForm({
          mode: saved.mode,
          protocol: saved.protocol,
          host: saved.host,
          port: saved.port,
          username: saved.username ?? '',
          password: '', // 不回传明文：留空即保持原密码
          bypass: saved.bypass ?? '',
          proxyPrivateNetworks: saved.proxyPrivateNetworks,
        });
        setHasPassword(saved.hasPassword);
        setClearPassword(false);
      } catch {
        if (!cancelled) setForm(DEFAULTS);
      }
    })();
    void probeSystemProxy();
    return () => {
      cancelled = true;
    };
  }, [opened, probeSystemProxy]);

  const patch = (part: Partial<ProxySettingsInput>) => setForm((f) => ({ ...f, ...part }));

  const handleSave = async () => {
    setSaving(true);
    try {
      const saved = await getApi().saveProxySettings({ ...form, clearPassword });
      setHasPassword(saved.hasPassword);
      setForm((f) => ({ ...f, password: '' }));
      setClearPassword(false);
      notifications.show({ message: '代理设置已保存并生效' });
      onClose();
    } catch (err) {
      notifications.show({ color: 'red', message: `保存失败：${errText(err)}` });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await getApi().testProxy({ ...form, clearPassword });
      notifications.show({
        color: res.ok ? 'teal' : 'red',
        message: res.latencyMs != null ? `${res.message}（${res.latencyMs}ms）` : res.message,
      });
      // 使系统代理的展示保持最新
      if (form.mode === 'system') void probeSystemProxy();
    } catch (err) {
      notifications.show({ color: 'red', message: `测试失败：${errText(err)}` });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="设置" size={560}>
      <Stack gap="sm">
        {/* ── 网络代理 ── */}
        <Group gap={6}>
          <IconWorld size={15} style={{ color: 'var(--iv-text-3)' }} />
          <Text fw={600} size="sm">
            网络代理
          </Text>
        </Group>

        <Radio.Group
          value={form.mode}
          onChange={(v) => patch({ mode: v as ProxyMode })}
        >
          <Stack gap={6}>
            {MODES.map((m) => (
              <Box
                key={m.value}
                style={{
                  border: `1px solid ${
                    form.mode === m.value ? 'var(--mantine-color-blue-5)' : 'var(--iv-border)'
                  }`,
                  borderRadius: 8,
                  padding: '6px 10px',
                  background: form.mode === m.value ? 'var(--iv-bg-app)' : 'transparent',
                  cursor: 'pointer',
                }}
                onClick={() => patch({ mode: m.value })}
              >
                <Radio value={m.value} label={m.label} description={m.description} />
              </Box>
            ))}
          </Stack>
        </Radio.Group>

        {/* 系统代理探测结果：让「使用系统代理」这一步是可见、可验证的 */}
        {form.mode === 'system' && (
          <Box
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 10px',
              borderRadius: 6,
              border: '1px solid var(--iv-border-light)',
              background: 'var(--iv-bg-app)',
            }}
          >
            <Text size="xs" c="dimmed">
              当前系统代理
            </Text>
            <Badge size="sm" variant="light" color={systemProxy?.direct ? 'gray' : 'blue'}>
              {probingSystem ? '探测中…' : (systemProxy?.display ?? '未知')}
            </Badge>
            <Box style={{ flex: 1 }} />
            <Button
              variant="subtle"
              size="compact-xs"
              leftSection={<IconRefresh size={12} />}
              loading={probingSystem}
              onClick={() => void probeSystemProxy()}
            >
              重新探测
            </Button>
          </Box>
        )}

        {/* 自定义代理明细 */}
        {form.mode === 'custom' && (
          <>
            <Group align="flex-start" gap="sm" wrap="nowrap">
              <Select
                label="代理协议"
                data={[
                  { value: 'http', label: 'HTTP' },
                  { value: 'https', label: 'HTTPS' },
                  { value: 'socks5', label: 'SOCKS5' },
                ]}
                value={form.protocol}
                onChange={(v) => patch({ protocol: (v as ProxyProtocol) || 'http' })}
                allowDeselect={false}
                style={{ width: 132 }}
              />
              <TextInput
                label="代理地址"
                placeholder="127.0.0.1"
                value={form.host}
                onChange={(e) => patch({ host: e.currentTarget.value })}
                style={{ flex: 1, minWidth: 0 }}
              />
              <NumberInput
                label="端口"
                placeholder="7890"
                min={1}
                max={65535}
                value={form.port}
                onChange={(v) => patch({ port: typeof v === 'number' ? v : Number(v) || 0 })}
                style={{ width: 104 }}
              />
            </Group>
            <Group grow align="flex-start" gap="sm">
              <TextInput
                label="用户名"
                placeholder="（可选）代理认证用户名"
                value={form.username}
                onChange={(e) => patch({ username: e.currentTarget.value })}
              />
              <PasswordInput
                label="密码"
                placeholder={hasPassword ? '留空保持已保存的密码' : '（可选）'}
                autoComplete="off"
                disabled={clearPassword}
                value={form.password}
                onChange={(e) => patch({ password: e.currentTarget.value })}
              />
            </Group>
            {hasPassword && (
              <Checkbox
                size="xs"
                label="清除已保存的代理密码"
                checked={clearPassword}
                onChange={(e) => setClearPassword(e.currentTarget.checked)}
              />
            )}
          </>
        )}

        {form.mode !== 'none' && (
          <>
            <Divider my={2} />
            <TextInput
              label="直连名单"
              placeholder="例如：*.internal.com, 10.0.0.5, *"
              description="命中这些主机时直连；支持 * 与 ? 通配，逗号 / 空格分隔。"
              value={form.bypass ?? ''}
              onChange={(e) => patch({ bypass: e.currentTarget.value })}
            />
            <Checkbox
              label="对局域网与本机地址也使用代理"
              description="默认关闭：本机与内网地址（如 192.168.x.x、localhost）始终直连。"
              checked={form.proxyPrivateNetworks === true}
              onChange={(e) => patch({ proxyPrivateNetworks: e.currentTarget.checked })}
            />
          </>
        )}

        <Alert
          variant="light"
          color="gray"
          icon={<IconInfoCircle size={14} />}
          styles={{ message: { fontSize: 12 } }}
        >
          代理对 InfluxDB 连接与应用更新同时生效，保存后立即应用。
          {form.mode === 'system' && '系统代理若需要账号密码，请改用「自定义代理」。'}
        </Alert>

        {/* ── 操作区 ── */}
        <Divider />
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="default"
            leftSection={<IconPlugConnected size={14} />}
            loading={testing}
            onClick={() => void handleTest()}
          >
            测试代理
          </Button>
          <Button
            leftSection={<IconDeviceFloppy size={14} />}
            loading={saving}
            onClick={() => void handleSave()}
          >
            保存
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
