import { useEffect, useState, useCallback } from 'react';
import { Modal, Button, Group, Text } from '@mantine/core';
import { IconRefresh, IconCopy } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';

export interface ErrorInfo {
  /** 错误标题 */
  title: string;
  /** 错误消息（正文） */
  message: string;
  /** 可选的堆栈或附加详情 */
  stack?: string;
  /** 出错时间 */
  at: number;
}

/** 全局错误状态（不放入 zustand，保持独立，避免错误处理本身依赖业务 store） */
let pushErrorFn: ((e: ErrorInfo) => void) | null = null;

/** 供任意位置调用的全局错误上报 */
export function reportError(title: string, message: string, stack?: string) {
  pushErrorFn?.({ title, message, stack, at: Date.now() });
}

export function ErrorDialog() {
  const [queue, setQueue] = useState<ErrorInfo[]>([]);

  // 注册全局上报函数
  useEffect(() => {
    pushErrorFn = (e) => setQueue((q) => [...q, e]);
    return () => {
      pushErrorFn = null;
    };
  }, []);

  // 捕获未处理的 Promise rejection 和同步错误
  useEffect(() => {
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      reportError(
        '未处理的异步错误',
        reason instanceof Error ? reason.message : String(reason),
        reason instanceof Error ? reason.stack : undefined,
      );
    };
    const onError = (event: ErrorEvent) => {
      const msg = event.error instanceof Error ? event.error.message : event.message;
      // 过滤浏览器良性警告：ResizeObserver 在一帧内未交付回调时会抛此提示，
      // 不影响功能，但会被这里误报为“脚本错误”弹窗。
      if (typeof msg === 'string' && msg.includes('ResizeObserver loop')) {
        event.preventDefault?.();
        return;
      }
      // 忽略资源加载错误（target 为元素），只处理脚本运行错误
      if (event.error instanceof Error) {
        reportError('脚本错误', event.error.message, event.error.stack);
      } else if (event.message) {
        reportError('脚本错误', event.message);
      }
    };
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    window.addEventListener('error', onError);
    return () => {
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      window.removeEventListener('error', onError);
    };
  }, []);

  const current = queue[0];
  const handleClose = useCallback(() => {
    setQueue((q) => q.slice(1));
  }, []);
  const handleReload = useCallback(() => {
    window.location.reload();
  }, []);
  const handleCopy = useCallback(() => {
    if (!current) return;
    const text = `${current.title}\n${current.message}${current.stack ? '\n\n' + current.stack : ''}`;
    void navigator.clipboard.writeText(text).then(() => notifications.show({ message: '已复制错误信息' }));
  }, [current]);

  return (
    <Modal
      opened={!!current}
      onClose={handleClose}
      title={
        <Group gap={8} wrap="nowrap" style={{ color: 'var(--mantine-color-red-6)' }}>
          <span
            style={{
              display: 'inline-flex',
              width: 20,
              height: 20,
              borderRadius: '50%',
              background: 'var(--mantine-color-red-6)',
              color: '#fff',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 13,
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            !
          </span>
          <span>{current?.title || '出错了'}</span>
        </Group>
      }
      withCloseButton
      closeOnClickOutside={false}
    >
      {current && (
        <div>
          <Text size="sm" style={{ marginBottom: 8 }}>
            {current.message}
          </Text>
          {current.stack && (
            <pre
              style={{
                background: 'var(--mantine-color-gray-1)',
                padding: 10,
                borderRadius: 4,
                fontSize: 12,
                fontFamily: 'monospace',
                maxHeight: 240,
                overflow: 'auto',
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: 'var(--iv-text-2)',
              }}
            >
              {current.stack}
            </pre>
          )}
          {/* 底部操作区 */}
          <Group justify="space-between" align="center" wrap="nowrap" mt="lg">
            <Text size="xs" c="dimmed">
              {new Date(current.at).toLocaleString()}
            </Text>
            <Group gap={8}>
              <Button variant="default" leftSection={<IconCopy size={14} />} onClick={handleCopy}>
                复制
              </Button>
              <Button leftSection={<IconRefresh size={14} />} onClick={handleReload}>
                重新加载
              </Button>
              <Button variant="default" onClick={handleClose}>
                关闭
              </Button>
            </Group>
          </Group>
        </div>
      )}
    </Modal>
  );
}
