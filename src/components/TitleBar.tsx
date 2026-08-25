import { useEffect, useState } from 'react';
import { IconMinus, IconMaximize, IconMinimize, IconX } from '@tabler/icons-react';

/** 窗口控制 API（preload 暴露） */
interface WindowControlsApi {
  minimize: () => void;
  toggleMaximize: () => Promise<boolean>;
  close: () => void;
  onMaximizedChange: (cb: (maximized: boolean) => void) => () => void;
}

function getWindowApi(): WindowControlsApi | null {
  // macOS 用系统红绿灯按钮，渲染层不需要自绘控制按钮
  if (navigator.userAgent.includes('Macintosh')) return null;
  return (
    (window as unknown as { windowControls?: WindowControlsApi }).windowControls || null
  );
}

/** 自绘标题栏：拖拽区 + 窗口控制按钮。
 *  - macOS 保留系统红绿灯按钮，只渲染左侧拖拽区（内容自动避让红绿灯）
 *  - Windows/Linux 渲染完整控制按钮（最小化/最大化还原/关闭）
 */
export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  const api = getWindowApi();

  useEffect(() => {
    if (!api) return;
    // 只订阅最大化状态变化（主进程在 maximize/unmaximize 事件时推送），
    // 不主动调用 toggleMaximize，避免初始化时误切换窗口状态。
    const off = api.onMaximizedChange(setMaximized);
    return off;
  }, [api]);

  const handleMinimize = () => api?.minimize();
  const handleToggleMax = async () => {
    if (!api) return;
    const next = await api.toggleMaximize();
    setMaximized(next);
  };
  const handleClose = () => api?.close();

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 32,
        flexShrink: 0,
        background: 'var(--iv-bg-panel)',
        borderBottom: '1px solid var(--iv-border)',
        // 整个标题栏可拖拽；按钮设 no-drag 让其可点击
        WebkitAppRegion: 'drag',
        userSelect: 'none',
      } as React.CSSProperties}
    >
      {/* macOS 左侧需留出红绿灯按钮的空间 */}
      <div style={{ width: navigator.userAgent.includes('Macintosh') ? 76 : 12 }} />
      <span style={{ fontSize: 12, color: 'var(--iv-text-3)', flex: 1 }}>
        InfluxDB View
      </span>

      {/* 窗口控制按钮（仅 Windows/Linux） */}
      {api && (
        <div style={{ display: 'flex', height: '100%', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <ControlButton onClick={handleMinimize} title="最小化">
            <IconMinus size={14} />
          </ControlButton>
          <ControlButton onClick={handleToggleMax} title={maximized ? '还原' : '最大化'}>
            {maximized ? <IconMinimize size={14} /> : <IconMaximize size={14} />}
          </ControlButton>
          <ControlButton onClick={handleClose} title="关闭" danger>
            <IconX size={14} />
          </ControlButton>
        </div>
      )}
    </div>
  );
}

function ControlButton({
  children,
  onClick,
  title,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  danger?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        width: 46,
        height: '100%',
        border: 'none',
        background: 'transparent',
        // 关闭按钮默认也是中性色；hover 时才变红（Windows 习惯）
        color: 'var(--iv-text-2)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 14,
        transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => {
        if (danger) {
          e.currentTarget.style.background = 'var(--mantine-color-red-6)';
          e.currentTarget.style.color = '#fff';
        } else {
          e.currentTarget.style.background = 'var(--mantine-color-gray-2)';
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = 'var(--iv-text-2)';
      }}
    >
      {children}
    </button>
  );
}
