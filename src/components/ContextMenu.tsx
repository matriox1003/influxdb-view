import { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface CtxMenuItem {
  key: string;
  label: string;
  onClick: () => void;
  /** 灰显（不可点击），如无选中文本时禁用“复制/剪切” */
  disabled?: boolean;
  /** 分隔线：置 true 时该项渲染为分隔线，label/onClick 被忽略 */
  divider?: boolean;
  /** 子菜单（悬浮展开）；有 children 时该项本身不可点击，onClick 被忽略 */
  children?: CtxMenuItem[];
}

interface CtxMenuData {
  x: number;
  y: number;
  items: CtxMenuItem[];
}

// module-level ref：不触发消费组件重渲染
let menuResolve: ((data: CtxMenuData) => void) | null = null;

/** 在指定位置弹出右键菜单。调用方组件不会因此重渲染。 */
export function showContextMenu(data: CtxMenuData) {
  menuResolve?.(data);
}

/** 关闭当前右键菜单 */
export function hideContextMenu() {
  menuResolve?.(null as unknown as CtxMenuData);
}

/**
 * 全局右键菜单 Portal（自绘，坐标定位）。
 * 挂载到 document.body，独立于业务组件树——菜单显隐不会触发表格/编辑器重渲染。
 * 在 App 中放置一个 <ContextMenu /> 即可。
 * 不用 Mantine Menu：其定位基于 Target 元素，不适合"指定屏幕坐标"弹菜单。
 * 支持一层子菜单（CSS :hover 展开），供对象浏览器“查看标签值”等场景复用，
 * 避免每个树节点挂一个 Mantine Menu 实例。
 */
export function ContextMenu() {
  const [menu, setMenu] = useState<CtxMenuData | null>(null);
  // 用 ref 稳住回调引用，避免每次渲染都更新 menuResolve
  const setMenuRef = useRef(setMenu);
  setMenuRef.current = setMenu;

  useEffect(() => {
    menuResolve = (data) => setMenuRef.current(data);
    return () => {
      menuResolve = null;
    };
  }, []);

  const close = useCallback(() => setMenu(null), []);

  const runItem = useCallback(
    (items: CtxMenuItem[], key: string) => {
      for (const item of items) {
        if (item.key === key) {
          item.onClick();
          close();
          return;
        }
        if (item.children) runItem(item.children, key);
      }
    },
    [close],
  );

  // Esc 关闭
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  const renderItem = useCallback(
    (item: CtxMenuItem): React.ReactNode => {
      if (item.divider) {
        return (
          <div
            key={item.key}
            style={{ height: 1, background: 'var(--iv-border-light)', margin: '4px 8px' }}
          />
        );
      }
      const buttonStyle: React.CSSProperties = {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        textAlign: 'left',
        padding: '5px 10px',
        border: 'none',
        borderRadius: 4,
        background: 'transparent',
        color: item.disabled ? 'var(--iv-text-3)' : 'var(--iv-text-1)',
        fontSize: 13,
        cursor: item.disabled ? 'not-allowed' : 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
      };
      const hoverHandlers = item.disabled
        ? {}
        : {
            onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => {
              e.currentTarget.style.background = 'var(--mantine-color-gray-1)';
            },
            onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => {
              e.currentTarget.style.background = 'transparent';
            },
          };
      const button = (
        <button
          key={item.key}
          type="button"
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled || item.children) return;
            item.onClick();
            close();
          }}
          style={buttonStyle}
          {...hoverHandlers}
        >
          <span style={{ flex: 1 }}>{item.label}</span>
          {item.children && item.children.length > 0 && (
            <span style={{ opacity: 0.6, fontSize: 11 }}>▸</span>
          )}
        </button>
      );
      // 有子菜单：包一层相对定位容器，hover 时展开右侧子面板
      if (item.children && item.children.length > 0) {
        return (
          <div key={item.key} className="iv-ctx-item">
            {button}
            <div className="iv-ctx-sub">
              {item.children.map((child) => renderItem(child))}
            </div>
          </div>
        );
      }
      return button;
    },
    [close],
  );

  if (!menu) return null;

  return createPortal(
    <>
      {/* 透明遮罩：点击任意处关闭。z-index 高于 Mantine Modal(300)，确保 Modal 内菜单可关闭 */}
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 2000 }}
        onClick={() => setMenu(null)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu(null);
        }}
      />
      <div
        style={{
          position: 'fixed',
          left: menu.x,
          top: menu.y,
          zIndex: 2001,
          background: 'var(--iv-bg-elevated)',
          border: '1px solid var(--iv-border)',
          borderRadius: 'var(--mantine-radius-sm)',
          boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
          padding: 4,
          minWidth: 140,
        }}
      >
        {menu.items.map((item) => renderItem(item))}
      </div>
    </>,
    document.body,
  );
}
