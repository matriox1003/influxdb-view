/**
 * 检查更新弹窗：
 * - 打开时自动检查（GitHub Releases 上的 latest.yml）
 * - 有新版本：显示版本号/发布说明，可下载（带进度条）并安装
 * - 无新版本/网络失败：给出对应提示
 */
import { useEffect, useState } from 'react';
import { Modal, Button, Text, Stack, Progress, Anchor, Divider, Box } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconExternalLink } from '@tabler/icons-react';
import type { UpdateCheckResult, UpdateProgress } from '@/types';
import { getUpdaterApi } from '@/types';

type UpdateStatus = 'checking' | 'idle' | 'downloading' | 'downloaded';

export function UpdateModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const api = getUpdaterApi();
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [status, setStatus] = useState<UpdateStatus>('checking');
  const [progress, setProgress] = useState<UpdateProgress | null>(null);

  // 打开时自动检查（检查结束后无论有无更新都切到 idle 展示结果）
  useEffect(() => {
    if (!opened || !api) return;
    setStatus('checking');
    setResult(null);
    setProgress(null);
    api
      .check()
      .then((r) => {
        setResult(r);
        setStatus('idle');
      })
      .catch(() => {
        // 检查请求本身失败（IPC 异常等）：给用户可见的错误文案而非空白弹窗
        setResult({
          available: false,
          version: null,
          currentVersion: '',
          releaseNotes: null,
          releaseUrl: null,
          error: '检查请求失败，请稍后重试',
        });
        setStatus('idle');
      });
  }, [opened, api]);

  // 订阅下载进度 / 完成
  useEffect(() => {
    if (!api) return;
    const offP = api.onProgress((p) => {
      setStatus('downloading');
      setProgress(p);
    });
    const offD = api.onDownloaded(() => setStatus('downloaded'));
    return () => {
      offP();
      offD();
    };
  }, [api]);

  const handleDownload = async () => {
    if (!api) return;
    // 立即进入 downloading 态禁用按钮：首个进度事件可能几秒后才到，
    // 这段空窗期连点虽无副作用（electron-updater 复用同一下载 Promise），
    // 但 UI 应即时反馈
    setStatus('downloading');
    const r = await api.download();
    if (!r.ok) {
      notifications.show({ color: 'red', message: `下载失败：${r.error || '未知错误'}` });
      setStatus('idle');
    }
  };

  const handleInstall = () => {
    if (!api) return;
    // 点击后应用立即退出：主进程先拉起独立进度窗口（跨生命周期）再静默安装
    onClose();
    api.install();
  };

  const fmtSize = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

  return (
    <Modal opened={opened} onClose={onClose} title="检查更新" size={480}>
      <Stack gap="sm">
        {/* 开发环境（无 preload API）提示 */}
        {!api && <Text size="sm" c="dimmed">当前为开发环境，更新功能仅在安装版中可用。</Text>}

        {api && status === 'checking' && <Text size="sm" c="dimmed">正在检查更新…</Text>}

        {api && result && status === 'idle' && (
          result.portable ? (
            <Stack gap="xs">
              <Text size="sm" c="orange">当前为便携版，不支持应用内更新。</Text>
              {result.releaseUrl && (
                <Anchor href={result.releaseUrl} target="_blank" size="xs" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <IconExternalLink size={12} /> 在 GitHub 下载最新版本
                </Anchor>
              )}
            </Stack>
          ) : result.error ? (
            <Text size="sm" c="orange">检查失败：{result.error}</Text>
          ) : result.available ? (
            <Stack gap="xs">
              <Text size="sm">
                发现新版本 <Text span fw={700}>v{result.version}</Text>
                （当前 v{result.currentVersion}）
              </Text>
            </Stack>
          ) : (
            <Text size="sm" c="dimmed">已是最新版本（v{result.currentVersion}）。</Text>
          )
        )}

        {/* 新版本：发布说明 + 下载按钮 */}
        {api && result?.available && (status === 'idle' || status === 'downloading') && (
          <>
            {result.releaseUrl && (
              <Anchor href={result.releaseUrl} target="_blank" size="xs" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <IconExternalLink size={12} /> 在 GitHub 查看此版本
              </Anchor>
            )}
            {result.releaseNotes && (
              <>
                <Divider />
                <Box
                  style={{
                    maxHeight: 220,
                    overflow: 'auto',
                    fontSize: 12,
                    lineHeight: 1.6,
                    whiteSpace: 'pre-wrap',
                    color: 'var(--iv-text-2)',
                  }}
                >
                  {result.releaseNotes}
                </Box>
              </>
            )}
          </>
        )}

        {/* 下载进度 */}
        {status === 'downloading' && (
          <Stack gap={4}>
            <Progress value={progress?.percent ?? 0} size="sm" />
            <Text size="xs" c="dimmed">
              {progress
                ? `${progress.percent.toFixed(0)}% · ${fmtSize(progress.transferred)} / ${fmtSize(progress.total)} · ${(progress.bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`
                : '准备下载…'}
            </Text>
          </Stack>
        )}

        {/* 下载完成 */}
        {status === 'downloaded' && (
          <Stack gap="xs">
            <Text size="sm" c="teal">更新已就绪，重启应用完成安装。</Text>
            <Text size="xs" c="dimmed">应用将自动退出并在安装完成后重新启动。</Text>
          </Stack>
        )}

        {/* 操作区 */}
        <Divider />
        <Box style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {status === 'downloading' ? (
            <Button size="sm" variant="subtle" disabled>下载中…</Button>
          ) : status === 'downloaded' ? (
            <Button size="sm" onClick={handleInstall}>重启并更新</Button>
          ) : result?.available && status === 'idle' ? (
            <Button size="sm" onClick={() => void handleDownload()}>下载更新</Button>
          ) : (
            <Button size="sm" variant="subtle" onClick={onClose}>关闭</Button>
          )}
        </Box>
      </Stack>
    </Modal>
  );
}
