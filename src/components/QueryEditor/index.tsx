import { useEffect, useRef, useState, memo } from 'react';
import { Button, Group, Select, Tooltip, Text, SegmentedControl, Menu, Modal, TextInput, Alert, Loader } from '@mantine/core';
import {
  IconPlayerPlayFilled,
  IconHistory,
  IconDownload,
  IconStar,
  IconStarFilled,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { EditorState, Prec, Compartment } from '@codemirror/state';
import { PostgreSQL } from '@codemirror/lang-sql';
import { autocompletion, type CompletionContext, type Completion, type CompletionResult } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, syntaxTree } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { useShallow } from 'zustand/react/shallow';
import { useConnectionStore } from '@/store/useConnectionStore';
import { useWorkspaceStore } from '@/store/useWorkspaceStore';
import { useDatabaseStore } from '@/store/useDatabaseStore';
import { useSchemaStore } from '@/store/useSchemaStore';
import { getApi } from '@/types';
import type { InfluxSeries, InfluxQueryResponse } from '@/types';
import { exportToXlsx, exportToJson } from '@/utils/exporter';
import { ResultTable } from './ResultTable';
import { showContextMenu } from '@/components/ContextMenu';

/**
 * InfluxQL 相对 PostgreSQL 方言多出的专有关键字/子句。
 * keywordCompletionSource(PostgreSQL) 覆盖通用 SQL 关键字（SELECT/FROM/WHERE...），
 * 这里补充 InfluxDB 特有：SHOW MEASUREMENTS / TAG KEYS / FIELD KEYS / RETENTION POLICY 等。
 */
/** CodeMirror 补全源类型（同步或异步均可） */
type CompletionSource = (ctx: CompletionContext) => CompletionResult | null | Promise<CompletionResult | null>;

/**
 * InfluxQL + 核心 SQL 关键字（精简版，约 60 个，覆盖常用查询）。
 */
const INFLUX_KEYWORDS: Completion[] = [
  // 核心 DQL
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'ORDER', 'ASC', 'DESC',
  'LIMIT', 'OFFSET', 'SLIMIT', 'SOFFSET', 'HAVING', 'DISTINCT', 'AS',
  'AND', 'OR', 'NOT', 'NULL', 'IN', 'BETWEEN', 'LIKE', 'IS',
  // 聚合 / 时间
  'COUNT', 'SUM', 'MEAN', 'MEDIAN', 'MIN', 'MAX', 'SPREAD', 'STDDEV',
  'FIRST', 'LAST', 'PERCENTILE', 'DERIVATIVE', 'INTEGRAL', 'MOVING_AVERAGE',
  'TIME', 'NOW', 'FILL', 'INTERVAL',
  // InfluxQL 专有：SHOW 系列
  'SHOW', 'MEASUREMENTS', 'TAG', 'KEYS', 'KEY', 'VALUES', 'FIELD', 'FIELDS',
  'RETENTION', 'POLICY', 'POLICIES', 'DATABASES', 'SERIES', 'CONTINUOUS',
  'QUERIES', 'USERS', 'GRANTS', 'DIAGNOSTICS', 'SUBSCRIPTIONS', 'SHARDS',
  'WITH', 'MEASUREMENT', 'ON', 'EXPLAIN',
  // DDL / DML
  'CREATE', 'DROP', 'DELETE', 'ALTER', 'INTO', 'INSERT',
  'GRANT', 'REVOKE', 'USE', 'SET',
  // JOIN 相关（InfluxQL 不支持，但 dialect 兼容）
  'INNER', 'LEFT', 'RIGHT', 'OUTER', 'JOIN', 'UNION',
].map((kw) => ({ label: kw, type: 'keyword', boost: -1 }));

/**
 * 补全源：无条件返回所有候选项（关键字 / 数据库名 / 表名 / 字段名 / tag）。
 * 不在任何位置做限制 —— 在编辑区任意位置都能触发补全。
 *
 * 候选数组按 `connId|db|schemaVersion` 缓存：schema 未变化时每次补全直接复用
 * 同一数组引用，不再每敲一个字符就遍历全部 measurement 的 fields/tags 重建。
 */
function makeCompletionSource(
  getConnectionId: () => string | undefined,
  getDatabase: () => string | undefined,
): CompletionSource {
  // 补全候选缓存：key 含 schemaVersion，schema 变化自动失效重建
  let cacheKey = '';
  let cachedOptions: Completion[] | null = null;

  return (ctx) => {
    // 字符串内部不提示
    const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
    if (node.name === 'String' || node.name === 'QuotedIdentifier') return null;

    // 匹配光标前的标识符片段（用于确定替换范围）
    const word = ctx.matchBefore(/[A-Za-z_]\w*/);
    // 不在空白位置弹窗（按空格/逗号不提示），Ctrl+Space 手动触发时允许
    if (!word && !ctx.explicit) return null;
    const from = word ? word.from : ctx.pos;

    const connId = getConnectionId();
    const db = getDatabase();
    const version = connId && db ? useSchemaStore.getState().schemaVersion : -1;
    const key = `${connId ?? ''}|${db ?? ''}|${version}`;

    if (key !== cacheKey || !cachedOptions) {
      const options: Completion[] = [...INFLUX_KEYWORDS];

      if (connId && db) {
        const schemaStore = useSchemaStore.getState();
        const dbStore = useDatabaseStore.getState();

        // 数据库名（boost 高，排前面）
        dbStore.get(connId).forEach((d) =>
          options.push({ label: d, type: 'namespace', boost: 20 }),
        );

        // 表名 / measurement（boost 高）
        const measurements = schemaStore.getMeasurements(connId, db);
        measurements.forEach((m) =>
          options.push({ label: m, type: 'type', boost: 15 }),
        );

        // 字段名：合并当前库所有已加载 measurement 的字段（boost 高）
        const fieldSet = new Set<string>();
        measurements.forEach((m) => {
          schemaStore.getFields(connId, db, m).forEach((f) => fieldSet.add(f));
        });
        fieldSet.forEach((f) =>
          options.push({ label: f, type: 'property', boost: 10 }),
        );

        // tag 名：合并当前库所有已加载 measurement 的 tag（boost 同字段）
        const tagSet = new Set<string>();
        measurements.forEach((m) => {
          schemaStore.getTags(connId, db, m).forEach((t) => tagSet.add(t));
        });
        tagSet.forEach((t) =>
          options.push({ label: t, type: 'enum', boost: 10 }),
        );
      }

      cacheKey = key;
      cachedOptions = options;
    }

    // 按需异步加载：若 SQL 里有 FROM 表名但该表字段/tag 未缓存，后台拉取（下次补全生效）
    if (connId && db) {
      const schemaStore = useSchemaStore.getState();
      const fromMatch = ctx.state.doc.toString().match(/\bFROM\s+"?([A-Za-z_][\w]*)"?\b/i);
      if (fromMatch && fromMatch[1]) {
        if (!schemaStore.getFields(connId, db, fromMatch[1]).length) {
          void schemaStore.loadFields(connId, db, fromMatch[1]);
        }
        if (!schemaStore.getTags(connId, db, fromMatch[1]).length) {
          void schemaStore.loadTags(connId, db, fromMatch[1]);
        }
      }
    }

    return {
      from,
      options: cachedOptions,
      // 允许补全框在输入标识符字符时保持打开
      validFor: /^[A-Za-z_]\w*$/,
    };
  };
}

interface Props {
  tabId: string;
}

export const QueryEditor = memo(function QueryEditor({ tabId }: Props) {
  // 只订阅 database + editorHeight（变化频率低；sql 不订阅 —— CodeMirror 自行管理编辑内容，
  // 通过 viewRef 直接读取，避免每次按键触发 React 重渲染）。
  const { database: tabDatabase, editorHeight: tabEditorHeight } = useWorkspaceStore(
    useShallow((s) => {
      const t = s.tabs.find((tab) => tab.id === tabId);
      return { database: t?.database, editorHeight: t?.editorHeight };
    }),
  );
  // 编辑器区域高度：每个 tab 可独立拖拽调整（store 持久化），缺省 200px
  const editorHeight = Math.max(100, tabEditorHeight ?? 200);
  const updateTab = useWorkspaceStore((s) => s.updateTab);
  const activeConn = useConnectionStore((s) => s.connections.find((c) => c.id === s.activeId));
  // 数据库列表走全局缓存（多 Tab / Sidebar / DataManager 共享，避免重复 SHOW DATABASES）
  const databases = useDatabaseStore((s) => (activeConn?.id ? s.byConnection[activeConn.id] : undefined)) || [];
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<InfluxSeries[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ durationMs?: number; rows?: number; messages?: string[] } | null>(null);
  // 时间显示模式：true=UTC（默认），false=本地时间；结果区 SegmentedControl 可切换
  const [useUtc, setUseUtc] = useState(true);
  // 选中的结果行 key（全局行索引字符串）
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  // 历史抽屉可见性走全局 store，避免在本组件 setState 导致编辑器/表格重渲染卡顿
  const setHistoryVisible = useWorkspaceStore((s) => s.setHistoryVisible);
  // 收藏查询：setSavedVisible 开抽屉，addSavedQuery 写盘
  const setSavedVisible = useWorkspaceStore((s) => s.setSavedVisible);
  const addSavedQuery = useWorkspaceStore((s) => s.addSavedQuery);
  // 收藏弹窗：收集标题后保存当前编辑器 SQL
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveTitle, setSaveTitle] = useState('');

  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // 当前连接/库的 ref：供 schema 补全源读取最新值（编辑器不随连接变化重建）
  const connIdRef = useRef<string | undefined>(undefined);
  const dbRef = useRef<string | undefined>(undefined);
  connIdRef.current = activeConn?.id;
  dbRef.current = tabDatabase || activeConn?.database;
  // run 的 ref：快捷键回调始终调用最新的 run（避免闭包过期导致拿到旧库/旧连接）
  const runRef = useRef<() => Promise<void>>(() => Promise.resolve());
  // 查询竞态序号：每次 run 递增。响应返回时若序号已落后（期间又发起了新查询），
  // 说明本次结果已过期，直接丢弃，不再重建结果表 —— 否则多次快速查询会
  // 堆积在途请求，每个过期响应完成都触发一次完整表格重建（大结果集时卡顿主因）。
  const querySeqRef = useRef(0);
  // 字体缩放：Ctrl/Cmd + 滚轮调整。用 ref 持有当前字号，避免重建编辑器。
  const [fontSize, setFontSize] = useState(16);
  const fontSizeRef = useRef(16);
  // Compartment 让 theme（字号）可动态重配，无需重建编辑器
  const themeComp = useRef(new Compartment()).current;
  // Compartment 让编辑器暗色/亮色主题可动态切换
  const darkThemeComp = useRef(new Compartment()).current;
  const isDark = () => document.documentElement.getAttribute('data-mantine-color-scheme') === 'dark';

  // 分割条拖拽：编辑区/结果区之间的可调高度（高度持久化到 tab.editorHeight）
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startH: editorHeight };
    // 拖拽期间锁定光标与文本选择，避免选中编辑器里的内容
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      // 编辑区最少 100px、给结果区至少留 130px
      const max = (containerRef.current?.clientHeight ?? 800) - 130;
      const next = Math.min(Math.max(100, d.startH + (ev.clientY - d.startY)), max);
      updateTab(tabId, { editorHeight: next });
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // 触发数据库列表加载（命中缓存则零网络请求）
  useEffect(() => {
    if (activeConn?.id) void useDatabaseStore.getState().load(activeConn.id);
  }, [activeConn?.id]);

  // 选择数据库时一次性预加载：measurement 列表 + 每个 measurement 的字段。
  // force 不传：命中缓存零请求，重复选同一库不会重复查询。
  useEffect(() => {
    const connId = activeConn?.id;
    const db = tabDatabase || activeConn?.database;
    if (connId && db) void useSchemaStore.getState().preloadDatabase(connId, db);
  }, [activeConn?.id, tabDatabase, activeConn?.database]);

  // 初始化 CodeMirror
  useEffect(() => {
    if (!editorRef.current) return;

    // SQL 持久化防抖：docChanged 每次按键都触发，全量 toString + 写 store 是 O(文档长度)，
    // 长 SQL 时逐键开销可观。改为 300ms 尾沿防抖，卸载/切 tab 时立即冲刷兜底。
    let sqlTimer: ReturnType<typeof setTimeout> | null = null;
    const latestDoc = { text: '', dirty: false };
    const flushSqlNow = () => {
      if (sqlTimer) {
        clearTimeout(sqlTimer);
        sqlTimer = null;
      }
      // 仅在确实输入过时冲刷，避免用空串覆盖 store 里的已有 SQL
      if (latestDoc.dirty) {
        useWorkspaceStore.getState().updateTab(tabId, { sql: latestDoc.text });
      }
    };

    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        latestDoc.text = u.state.doc.toString();
        latestDoc.dirty = true;
        if (sqlTimer) clearTimeout(sqlTimer);
        sqlTimer = setTimeout(() => {
          sqlTimer = null;
          useWorkspaceStore.getState().updateTab(tabId, { sql: latestDoc.text });
        }, 300);
      }
    });

    // 字号 theme：由 compartment 包裹，Ctrl+滚轮时通过 reconfigure 动态更新
    const fontTheme = (size: number) =>
      EditorView.theme({
        '&': { backgroundColor: 'transparent', height: '100%', fontSize: `${size}px` },
        '.cm-scroller': { overflow: 'auto', fontSize: `${size}px` },
        '.cm-content': { fontSize: `${size}px` },
      });

    const state = EditorState.create({
      doc: useWorkspaceStore.getState().tabs.find((t) => t.id === tabId)?.sql || '',
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        PostgreSQL.language,
        // 补全：无条件提供关键字 + 数据库名 + 表名 + 字段名，通过 ref 读取最新连接/库
        autocompletion({
          override: [
            makeCompletionSource(
              () => connIdRef.current,
              () => dbRef.current,
            ),
          ],
          activateOnTyping: true,
          closeOnBlur: true,
        }),
        Prec.highest(
          keymap.of([
            {
              key: 'Ctrl-Enter',
              mac: 'Cmd-Enter',
              preventDefault: true,
              run: () => {
                void runRef.current();
                return true;
              },
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
        ),
        EditorView.lineWrapping,
        themeComp.of(fontTheme(fontSizeRef.current)),
        darkThemeComp.of(isDark() ? oneDark : []),
        updateListener,
      ],
    });

    const view = new EditorView({ state, parent: editorRef.current });
    viewRef.current = view;
    return () => {
      // 卸载/切 tab：冲刷未落盘的最后一次输入，避免丢字
      if (sqlTimer) flushSqlNow();
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // 监听暗色/亮色主题切换，动态重配编辑器主题
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const view = viewRef.current;
      if (view) {
        view.dispatch({
          effects: darkThemeComp.reconfigure(isDark() ? oneDark : []),
        });
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mantine-color-scheme'] });
    return () => observer.disconnect();
  }, [darkThemeComp]);

  // Ctrl/Cmd + 滚轮 缩放编辑器字号
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      // 滚轮向上放大、向下缩小；每次步进 1px，范围 10~30
      const delta = e.deltaY < 0 ? 1 : -1;
      const next = Math.min(30, Math.max(10, fontSizeRef.current + delta));
      if (next === fontSizeRef.current) return;
      fontSizeRef.current = next;
      setFontSize(next);
      // 动态重配 theme 的字号，无需重建编辑器
      const view = viewRef.current;
      if (view) {
        view.dispatch({
          effects: themeComp.reconfigure(
            EditorView.theme({
              '&': { backgroundColor: 'transparent', height: '100%', fontSize: `${next}px` },
              '.cm-scroller': { overflow: 'auto', fontSize: `${next}px` },
              '.cm-content': { fontSize: `${next}px` },
            }),
          ),
        });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [themeComp]);

  const run = async () => {
    if (!activeConn?.id) {
      notifications.show({ color: 'yellow', message: '请先选择连接' });
      return;
    }
    const sqlText = viewRef.current?.state.doc.toString().trim();
    if (!sqlText) {
      notifications.show({ color: 'yellow', message: '查询内容为空' });
      return;
    }
    setRunning(true);
    setError(null);
    setResult(undefined);
    setMeta(null);
    setSelectedKeys([]);
    const start = Date.now();
    // 本次查询的竞态序号：新查询会使序号递增，旧响应返回后据此判定过期
    const seq = ++querySeqRef.current;
    try {
      const res: InfluxQueryResponse = await getApi().query({
        connectionId: activeConn.id,
        database: tabDatabase || activeConn.database,
        query: sqlText,
      });
      const durationMs = Date.now() - start;
      const first = res.results?.[0];
      const series = first?.series;
      const messages = first?.messages?.map((m) => m.text);
      // 顶层 error 或每条 result 的 error
      if (res.error) throw new Error(res.error);
      if (first?.error) throw new Error(first.error);
      // 历史记录：查询确实已执行且无错误，无论结果是否过期都记录（并发查询各自入历史）
      useWorkspaceStore.getState().addHistory({
        id: `${Date.now()}_${seq}`,
        sql: sqlText,
        database: tabDatabase,
        at: Date.now(),
        ok: true,
        durationMs,
      });
      // 过期响应：期间已发起新查询，丢弃本次结果，不再重建表格
      if (seq !== querySeqRef.current) return;
      const rows = series?.reduce((acc, s) => acc + (s.values?.length || 0), 0) || 0;
      // series 可能为 undefined（InfluxDB 返回 {"results":[{"statement_id":0}]}，即无匹配数据）。
      // 此时用空数组而非 undefined，确保结果区显示“无数据”而非空白。
      setResult(series ?? []);
      setMeta({ durationMs, rows, messages });
    } catch (err) {
      // 失败历史同样记录（查询确实执行了）
      useWorkspaceStore.getState().addHistory({
        id: `${Date.now()}_${seq}`,
        sql: sqlText,
        database: tabDatabase,
        at: Date.now(),
        ok: false,
      });
      // 过期响应的错误丢弃（用户已不在看这次查询）
      if (seq !== querySeqRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      // 只有最新查询结束时才收掉 loading（过期查询不干扰按钮状态）
      if (seq === querySeqRef.current) setRunning(false);
    }
  };
  // 保持 ref 指向最新 run，快捷键回调始终拿到最新的连接/库
  runRef.current = run;

  // 打开收藏弹窗：预填标题为当前 SQL 前 30 字（去掉首尾空白和换行）
  const openSaveModal = () => {
    const sql = viewRef.current?.state.doc.toString().trim() || '';
    if (!sql) {
      notifications.show({ color: 'yellow', message: '查询内容为空' });
      return;
    }
    const firstLine = sql.replace(/\s+/g, ' ').slice(0, 30);
    setSaveTitle(firstLine);
    setSaveModalOpen(true);
  };

  // 确认收藏：写盘（连接 id + 当前库 + 编辑器 SQL）
  const handleSaveQuery = async () => {
    const sql = viewRef.current?.state.doc.toString().trim() || '';
    if (!sql || !activeConn?.id) return;
    const title = saveTitle.trim() || sql.replace(/\s+/g, ' ').slice(0, 30);
    await addSavedQuery({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      connectionId: activeConn.id,
      title,
      sql,
      database: tabDatabase || activeConn.database,
      createdAt: Date.now(),
    });
    setSaveModalOpen(false);
    notifications.show({ message: '已收藏' });
  };

  return (
    <div ref={containerRef} style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--iv-bg-elevated)' }}>
      {/* 工具栏 */}
      <div
        className="iv-toolbar"
        style={{ height: 38, gap: 6, padding: '0 10px', borderBottom: '1px solid var(--iv-border)' }}
      >
        <Select
          placeholder="选择数据库"
          style={{ width: 180 }}
          size="sm"
          value={tabDatabase || activeConn?.database || undefined}
          onChange={(v) => updateTab(tabId, { database: v ?? undefined })}
          searchable
          clearable
          data={databases}
        />
        <Button
          size="sm"
          loading={running}
          leftSection={<IconPlayerPlayFilled size={14} />}
          onClick={() => void run()}
        >
          执行
        </Button>
        <Tooltip label="快捷键 Ctrl/Cmd + Enter">
          <Text fz={12} c="dimmed">Ctrl+↵</Text>
        </Tooltip>
        <div style={{ width: 1, height: 16, background: 'var(--iv-border)', margin: '0 4px' }} />
        <Tooltip label="收藏当前查询语句">
          <Button size="compact-sm" variant="subtle" leftSection={<IconStar size={14} />} onClick={openSaveModal}>
            收藏
          </Button>
        </Tooltip>
        <Button size="compact-sm" variant="subtle" leftSection={<IconStarFilled size={14} />} onClick={() => setSavedVisible(true)}>
          已保存
        </Button>
        <Button size="compact-sm" variant="subtle" leftSection={<IconHistory size={14} />} onClick={() => setHistoryVisible(true)}>
          历史
        </Button>
        <div style={{ flex: 1 }} />
        {fontSize !== 16 && (
          <Text fz={12} c="dimmed">
            字号 {fontSize}px
          </Text>
        )}
        {meta?.durationMs !== undefined && (
          <Text fz={12} c="dimmed">
            {meta.rows ?? 0} 行 · {meta.durationMs} ms
          </Text>
        )}
      </div>

      {/* 编辑器（高度可由下方分割条拖拽调整，持久化到 tab.editorHeight） */}
      <div
        style={{
          flex: `0 0 ${editorHeight}px`,
          minHeight: 100,
          background: 'var(--iv-bg-panel)',
        }}
      >
        <div
          ref={editorRef}
          style={{ height: '100%' }}
          onContextMenu={(e) => {
            e.preventDefault();
            showContextMenu({
              x: e.clientX,
              y: e.clientY,
              items: [
                {
                  key: 'copySelected',
                  label: '复制选中内容',
                  onClick: () => {
                    const view = viewRef.current;
                    if (!view) return;
                    const state = view.state;
                    const selection = state.sliceDoc(
                      state.selection.main.from,
                      state.selection.main.to,
                    );
                    if (selection) {
                      void navigator.clipboard.writeText(selection).then(() => notifications.show({ message: '已复制' }));
                    }
                  },
                },
                {
                  key: 'paste',
                  label: '粘贴',
                  onClick: () => {
                    const view = viewRef.current;
                    if (!view) return;
                    void navigator.clipboard.readText().then((text) => {
                      if (!text) return;
                      view.focus();
                      view.dispatch(view.state.replaceSelection(text));
                      notifications.show({ message: '已粘贴' });
                    }).catch(() => notifications.show({ color: 'red', message: '读取剪贴板失败' }));
                  },
                },
                { key: 'd1', label: '', onClick: () => {}, divider: true },
                {
                  key: 'copyAll',
                  label: '复制全部',
                  onClick: () => {
                    const view = viewRef.current;
                    if (view) {
                      const all = view.state.doc.toString();
                      void navigator.clipboard.writeText(all).then(() => notifications.show({ message: '已复制' }));
                    }
                  },
                },
              ],
            });
          }}
        />
      </div>

      {/* 编辑区 / 结果区 垂直分割条：拖拽调整上下两块大小 */}
      <div className="iv-resize-h" onMouseDown={onResizeStart} role="separator" aria-orientation="horizontal" />

      {/* 结果区标题 */}
      <div
        style={{
          padding: '0 12px',
          height: 28,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          borderBottom: '1px solid var(--iv-border)',
          background: 'var(--iv-bg-panel)',
          flexShrink: 0,
        }}
      >
        <span className="iv-section-title">结果</span>
        {result && result.length > 0 && selectedKeys.length > 0 && (
          <Text fz={12} style={{ color: 'var(--mantine-primary-color-filled)' }}>
            已选 {selectedKeys.length} 行
          </Text>
        )}
        {result && result.length > 0 && (
          <Tooltip label="点击选行 · Shift 连续多选 · Ctrl 切换选择">
            <Text fz={10} c="dimmed">选择帮助</Text>
          </Tooltip>
        )}
        <div style={{ flex: 1 }} />
        {/* 导出：全部 / 选中（仅单 series 且有选中行时显示“选中”项） */}
        {result && result.length > 0 && (
          <Menu position="bottom-end" width={220}>
            <Menu.Target>
              <Button variant="subtle" size="compact-xs" leftSection={<IconDownload size={13} />}>
                导出
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item onClick={() => void exportToXlsx(result, undefined, useUtc)}>
                导出全部 → Excel
              </Menu.Item>
              <Menu.Item onClick={() => exportToJson(result, undefined, useUtc)}>
                导出全部 → JSON
              </Menu.Item>
              {selectedKeys.length > 0 && (
                <>
                  <Menu.Divider />
                  <Menu.Item
                    onClick={() =>
                      void exportToXlsx(result, new Set(selectedKeys), useUtc)
                    }
                  >
                    导出选中（{selectedKeys.length} 行）→ Excel
                  </Menu.Item>
                  <Menu.Item
                    onClick={() => exportToJson(result, new Set(selectedKeys), useUtc)}
                  >
                    导出选中（{selectedKeys.length} 行）→ JSON
                  </Menu.Item>
                </>
              )}
            </Menu.Dropdown>
          </Menu>
        )}
        {/* 时间显示模式切换：本地时间 / UTC */}
        {result && result.length > 0 && (
          <SegmentedControl
            size="sm"
            value={useUtc ? 'utc' : 'local'}
            onChange={(v) => setUseUtc(v === 'utc')}
            data={[
              { value: 'local', label: '本地' },
              { value: 'utc', label: 'UTC' },
            ]}
          />
        )}
      </div>

      {/* 结果内容：flex 撑满，表格自行处理滚动 */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: 8, gap: 8 }}>
        {error && (
          <Alert color="red" variant="light" title="查询出错">
            {error}
          </Alert>
        )}
        {meta?.messages && meta.messages.length > 0 && (
          <Alert color="blue" variant="light">
            {meta.messages.join('; ')}
          </Alert>
        )}
        {running ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Loader />
            <Text size="sm" c="dimmed" mt="xs">执行中…</Text>
          </div>
        ) : (
          result && (
            <ResultTable
              series={result}
              useUtc={useUtc}
              selectedKeys={selectedKeys}
              onSelectedKeysChange={setSelectedKeys}
            />
          )
        )}
      </div>

      {/* 收藏查询弹窗：填标题后保存当前编辑器 SQL */}
      <Modal
        opened={saveModalOpen}
        onClose={() => setSaveModalOpen(false)}
        title="收藏查询"
        size="sm"
      >
        <Text size="xs" c="dimmed" mb="xs">
          为这条查询起个名字：
        </Text>
        <TextInput
          placeholder="查询名称（留空则取 SQL 前 30 字）"
          value={saveTitle}
          onChange={(e) => setSaveTitle(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSaveQuery();
          }}
          spellCheck={false}
          mb="lg"
        />
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={() => setSaveModalOpen(false)}>
            取消
          </Button>
          <Button onClick={() => void handleSaveQuery()}>收藏</Button>
        </Group>
      </Modal>
    </div>
  );
});
