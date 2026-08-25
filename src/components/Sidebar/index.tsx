import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Tooltip, Input, Loader } from '@mantine/core';
import {
  IconDatabase,
  IconRefresh,
  IconSearch,
  IconChevronRight,
  IconFolderOpen,
  IconTable,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useConnectionStore } from '@/store/useConnectionStore';
import { useDatabaseStore } from '@/store/useDatabaseStore';
import { useSchemaStore } from '@/store/useSchemaStore';
import { getApi } from '@/types';
import type { InfluxSeries } from '@/types';
import { useWorkspaceStore } from '@/store/useWorkspaceStore';
import { showContextMenu, type CtxMenuItem } from '@/components/ContextMenu';

/** 节点类型标记，用于图标区分 */
type NodeType = 'db' | 'measurement' | 'placeholder';

interface TreeNodeData {
  key: string;
  /** 节点纯文本名称（用于搜索过滤） */
  name: string;
  /** 所属数据库名（measurement 节点有效；搜索拍平时也用于点击开查询） */
  db?: string;
  nodeType: NodeType;
  /** 数据库下的测量值数量（加载后填充，用于徽标） */
  count?: number;
  /** undefined = 未加载（展开时懒加载）；[] = 已加载为空 */
  children?: TreeNodeData[];
}

function valuesOf(series: InfluxSeries | undefined, col: string): string[] {
  if (!series?.values) return [];
  const idx = series.columns.indexOf(col);
  if (idx < 0) return [];
  return series.values.map((v) => String(v[idx])).filter(Boolean);
}

/**
 * 单个树节点行。右键复用全局 showContextMenu（不再每节点挂一个 Mantine Menu
 * 实例——大库展开上千行时省掉上千个 floating-ui 菜单对象）；memo 化后
 * 展开/收起/搜索只重渲染受影响节点。
 */
const TreeNodeRow = memo(function TreeNodeRow({
  node,
  connId,
  depth,
  expanded,
  toggle,
  loadChildren,
  onOpenQuery,
}: {
  node: TreeNodeData;
  connId: string;
  depth: number;
  expanded: boolean;
  toggle: (key: string) => void;
  loadChildren: (key: string) => void;
  onOpenQuery: (sql: string, db?: string) => void;
}) {
  const isDb = node.nodeType === 'db';
  const isMeasurement = node.nodeType === 'measurement';
  const measurement = node.db ? node.name : undefined;

  const handleClick = () => {
    if (!isDb) return;
    toggle(node.key);
    if (node.children === undefined) loadChildren(node.key);
  };

  // 右键菜单项：tag keys 直接读 schema store 缓存（选库时 preloadDatabase 已批量加载）。
  // 未加载时后台拉取并显示「加载中…」，再次右键即可见。
  const buildMenuItems = (): CtxMenuItem[] => {
    if (isDb) {
      return [
        {
          key: 'showMeasurements',
          label: 'SHOW MEASUREMENTS',
          onClick: () => onOpenQuery('SHOW MEASUREMENTS', node.name),
        },
        { key: 'd1', label: '', divider: true, onClick: () => undefined },
        {
          key: 'copyDb',
          label: '复制名称',
          onClick: () => {
            void navigator.clipboard.writeText(node.name);
            notifications.show({ message: '已复制' });
          },
        },
      ];
    }
    if (isMeasurement && node.db && measurement) {
      const schemaStore = useSchemaStore.getState();
      const tagsLoaded = schemaStore.hasTags(connId, node.db, measurement);
      if (!tagsLoaded) void schemaStore.loadTags(connId, node.db, measurement);
      const tagKeys = tagsLoaded ? schemaStore.getTags(connId, node.db, measurement) : [];
      const tagValueItems: CtxMenuItem[] = !tagsLoaded
        ? [{ key: 'tagvals-loading', label: '加载中…', onClick: () => undefined, disabled: true }]
        : tagKeys.length === 0
          ? [{ key: 'tagvals-empty', label: '（无标签）', onClick: () => undefined, disabled: true }]
          : tagKeys.map((tk) => ({
              key: `tagval:${tk}`,
              label: tk,
              onClick: () =>
                onOpenQuery(`SHOW TAG VALUES FROM "${measurement}" WITH KEY = "${tk}"`, node.db),
            }));
      return [
        {
          key: 'selectStar',
          label: 'SELECT * (近1秒)',
          onClick: () =>
            onOpenQuery(`SELECT * FROM "${measurement}" WHERE time > now() - 1s LIMIT 100`, node.db),
        },
        {
          key: 'showFields',
          label: '查看字段',
          onClick: () => onOpenQuery(`SHOW FIELD KEYS FROM "${measurement}"`, node.db),
        },
        {
          key: 'showTags',
          label: '查看标签',
          onClick: () => onOpenQuery(`SHOW TAG KEYS FROM "${measurement}"`, node.db),
        },
        { key: 'tagValues', label: '查看标签值', onClick: () => undefined, children: tagValueItems },
        {
          key: 'countAll',
          label: 'COUNT(*)',
          onClick: () => onOpenQuery(`SELECT count(*) FROM "${measurement}"`, node.db),
        },
        { key: 'd2', label: '', divider: true, onClick: () => undefined },
        {
          key: 'copyMeasurement',
          label: '复制名称',
          onClick: () => {
            void navigator.clipboard.writeText(measurement || '');
            notifications.show({ message: '已复制' });
          },
        },
      ];
    }
    return [];
  };

  return (
    <div
      className="iv-tree-node-row"
      role="button"
      style={{ paddingLeft: 6 + depth * 14 }}
      onClick={handleClick}
      onContextMenu={(e) => {
        e.preventDefault();
        const items = buildMenuItems();
        if (items.length > 0) {
          showContextMenu({ x: e.clientX, y: e.clientY, items });
        }
      }}
    >
      {isDb ? (
        <span className={`iv-tree-chevron${expanded ? ' iv-tree-chevron-open' : ''}`}>
          <IconChevronRight size={14} />
        </span>
      ) : (
        <span className="iv-tree-chevron-placeholder" />
      )}
      {isDb ? (
        <IconDatabase size={15} style={{ color: 'var(--iv-text-3)', flexShrink: 0 }} />
      ) : isMeasurement ? (
        <IconTable size={14} style={{ color: 'var(--iv-text-3)', flexShrink: 0 }} />
      ) : null}
      <span className="iv-tree-title">
        <span className="iv-tree-name">
          {node.name}
          {node.nodeType === 'placeholder' && <span className="iv-tree-empty">（无测量值）</span>}
        </span>
        {typeof node.count === 'number' && node.count > 0 && (
          <span className="iv-tree-badge">{node.count}</span>
        )}
      </span>
    </div>
  );
});

export function Sidebar() {
  const activeId = useConnectionStore((s) => s.activeId);
  const activeConn = useConnectionStore((s) => s.connections.find((c) => c.id === s.activeId));
  const openQuery = useWorkspaceStore((s) => s.openQuery);

  const [treeData, setTreeData] = useState<TreeNodeData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  // 当前连接 id 的 ref，用于请求返回时的竞态防护
  const connRef = useRef<string | null>(null);

  // 切换连接：重置并加载数据库列表
  useEffect(() => {
    connRef.current = activeId;
    setTreeData([]);
    setError(null);
    setKeyword('');
    setExpandedKeys([]);
    if (!activeId) {
      setLoading(false);
      return;
    }
    void loadDatabases(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  /** 不可变更新：替换指定 key 的节点（浅合并），返回新数组 */
  const patchNode = useCallback(
    (nodes: TreeNodeData[], key: string, patch: Partial<TreeNodeData>): TreeNodeData[] => {
      return nodes.map((n) => {
        if (n.key === key) return { ...n, ...patch };
        if (n.children) return { ...n, children: patchNode(n.children, key, patch) };
        return n;
      });
    },
    [],
  );

  const loadDatabases = useCallback(async (connId: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await getApi().query({ connectionId: connId, query: 'SHOW DATABASES' });
      if (connRef.current !== connId) return;
      const series = res.results?.[0]?.series?.[0];
      const dbs = valuesOf(series, 'name').filter((d) => d !== '_internal');
      setTreeData(
        dbs.map((d) => ({
          key: `db:${d}`,
          name: d,
          nodeType: 'db' as const,
          // children 不预置：展开时懒加载 SHOW MEASUREMENTS
        })),
      );
      // 顺便预热数据库列表缓存（QueryEditor / DataManager 共享）
      useDatabaseStore.setState((s) => ({ byConnection: { ...s.byConnection, [connId]: dbs } }));
    } catch (err) {
      if (connRef.current !== connId) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (connRef.current === connId) setLoading(false);
    }
  }, []);

  /** 懒加载：展开数据库节点时加载 measurement 列表 */
  const loadChildren = useCallback(
    async (key: string) => {
      const connId = connRef.current;
      if (!connId || !key.startsWith('db:')) return;
      const db = key.slice('db:'.length);
      try {
        const res = await getApi().query({
          connectionId: connId,
          database: db,
          query: 'SHOW MEASUREMENTS',
        });
        if (connRef.current !== connId) return;
        const ms = valuesOf(res.results?.[0]?.series?.[0], 'name');
        // 同步写入 schema store，供编辑器补全复用（树与补全共享同一份数据）
        useSchemaStore.setState((s) => ({
          measurements: { ...s.measurements, [`${connId}:${db}`]: ms },
        }));
        const children: TreeNodeData[] =
          ms.length === 0
            ? [{ key: `${key}:empty`, name: '', nodeType: 'placeholder' }]
            : ms.map((m) => ({ key: `m:${db}:${m}`, name: m, db, nodeType: 'measurement' as const }));
        setTreeData((prev) => patchNode(prev, key, { children, count: ms.length }));
      } catch (err) {
        if (connRef.current !== connId) return;
        notifications.show({ color: 'red', message: `加载测量值失败：${err instanceof Error ? err.message : String(err)}` });
      }
    },
    [patchNode],
  );

  const toggle = useCallback((key: string) => {
    setExpandedKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }, []);

  // 搜索过滤（纯过滤，不碰展开状态）：
  // - 无关键字：原样返回树
  // - 有关键字：把命中的测量值拍平成顶层列表（带「库名 ·」前缀，保留 db 供点击查询）
  const displayData = useMemo<TreeNodeData[]>(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return treeData;
    const flat: TreeNodeData[] = [];
    treeData.forEach((db) => {
      const dbName = db.name || '';
      const dbHit = dbName.toLowerCase().includes(kw);
      (db.children || []).forEach((c) => {
        if (c.nodeType !== 'measurement') return;
        if (dbHit || (c.name || '').toLowerCase().includes(kw)) {
          flat.push({ ...c, name: `${dbName} · ${c.name}` });
        }
      });
    });
    return flat;
  }, [treeData, keyword]);

  const totalCount = useMemo(() => {
    let n = 0;
    treeData.forEach((db) => {
      n += db.count || (db.children?.filter((c) => c.nodeType === 'measurement').length ?? 0);
    });
    return n;
  }, [treeData]);

  const searching = keyword.trim().length > 0;

  const onOpenQuery = useCallback(
    (sql: string, db?: string) => openQuery(sql, db),
    [openQuery],
  );

  // 递归渲染树：节点行 + 展开的 db 节点渲染子节点（缩进一层）
  const renderNodes = (nodes: TreeNodeData[], depth: number): React.ReactNode =>
    nodes.map((node) => (
      <Fragment key={node.key}>
        <TreeNodeRow
          node={node}
          connId={activeId!}
          depth={depth}
          expanded={expandedKeys.includes(node.key)}
          toggle={toggle}
          loadChildren={loadChildren}
          onOpenQuery={onOpenQuery}
        />
        {node.nodeType === 'db' &&
          expandedKeys.includes(node.key) &&
          node.children !== undefined && (
            <div className="iv-tree-children">
              {node.children.map((child) =>
                child.nodeType === 'placeholder' ? (
                  <div
                    key={child.key}
                    className="iv-tree-empty"
                    style={{ paddingLeft: 6 + (depth + 1) * 14 }}
                  >
                    （无测量值）
                  </div>
                ) : (
                  renderNodes([child], depth + 1)
                ),
              )}
            </div>
          )}
      </Fragment>
    ));

  return (
    <div className="iv-sidebar" style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--iv-bg-panel)' }}>
      {/* 标题栏 */}
      <div className="iv-sidebar-header">
        <span className="iv-section-title">对象浏览器</span>
        <div style={{ flex: 1 }} />
        {activeId && (
          <Tooltip label="刷新">
            <Button variant="subtle" size="compact-xs" aria-label="刷新" onClick={() => activeId && void loadDatabases(activeId)}>
              <IconRefresh size={14} />
            </Button>
          </Tooltip>
        )}
      </div>

      {/* 搜索框 */}
      {activeId && !error && (
        <div className="iv-sidebar-search">
          <Input
            size="xs"
            leftSection={<IconSearch size={13} />}
            placeholder="搜索测量值…"
            value={keyword}
            onChange={(e) => setKeyword(e.currentTarget.value)}
            rightSection={
              keyword ? (
                <Button variant="subtle" size="compact-xs" aria-label="清空" onClick={() => setKeyword('')}>
                  ✕
                </Button>
              ) : null
            }
          />
        </div>
      )}

      {/* 树内容 */}
      <div className="iv-sidebar-tree">
        {!activeId ? (
          <div className="iv-sidebar-state">
            <IconDatabase size={30} style={{ opacity: 0.35, marginBottom: 10 }} />
            <div style={{ fontSize: 12 }}>请先在顶部选择连接</div>
          </div>
        ) : loading ? (
          <div className="iv-sidebar-state">
            <Loader size={22} style={{ marginBottom: 10 }} />
            <span style={{ fontSize: 12 }}>加载中…</span>
          </div>
        ) : error ? (
          <div className="iv-sidebar-state">
            <div style={{ color: 'var(--mantine-color-red-6)', marginBottom: 10, fontSize: 12, lineHeight: 1.6 }}>{error}</div>
            <Button size="compact-xs" onClick={() => activeId && void loadDatabases(activeId)}>
              重试
            </Button>
          </div>
        ) : displayData.length === 0 ? (
          <div className="iv-sidebar-state">
            <IconFolderOpen size={26} style={{ opacity: 0.35, marginBottom: 10 }} />
            <div style={{ fontSize: 12 }}>{searching ? '无匹配测量值' : '暂无数据'}</div>
          </div>
        ) : (
          <div>
            {displayData.map((node) => {
              if (searching) {
                // 搜索态：拍平的 measurement 列表（点击打开 SELECT * 查询）
                const db = node.db || '';
                const measurement = node.name.includes(' · ') ? node.name.split(' · ').pop() : node.name;
                return (
                  <div
                    key={node.key}
                    className="iv-tree-node-row"
                    role="button"
                    onClick={() => onOpenQuery(`SELECT * FROM "${measurement}" LIMIT 100`, db)}
                  >
                    <span className="iv-tree-chevron-placeholder" />
                    <IconTable size={14} style={{ color: 'var(--iv-text-3)', flexShrink: 0 }} />
                    <span className="iv-tree-title">
                      <span className="iv-tree-name">{node.name}</span>
                    </span>
                  </div>
                );
              }
              return renderNodes([node], 0);
            })}
          </div>
        )}
      </div>

      {/* 底部状态栏 */}
      {activeConn && (
        <div className="iv-sidebar-footer">
          <span className="iv-dot iv-dot-live" />
          <span className="iv-sidebar-footer-text">
            {activeConn.database ? `默认库 ${activeConn.database}` : '未设默认库'}
          </span>
          {totalCount > 0 && <span className="iv-sidebar-footer-count">共 {totalCount} 表</span>}
        </div>
      )}
    </div>
  );
}
