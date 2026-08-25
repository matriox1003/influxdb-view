import { useEffect, useMemo, useRef, memo, useCallback } from 'react';
import { Tabs, Text } from '@mantine/core';
import {
  MantineReactTable,
  useMantineReactTable,
  type MRT_ColumnDef,
  type MRT_Row,
  type MRT_TableInstance,
} from 'mantine-react-table';
import type { InfluxSeries } from '@/types';
import { showContextMenu } from '@/components/ContextMenu';
import { formatCell } from '@/utils/format';

interface Props {
  series: InfluxSeries[] | undefined;
  /** true=显示 UTC 时间，false=本地时间 */
  useUtc?: boolean;
  /** 选中的行 key（全局行索引字符串，单 series 有效） */
  selectedKeys?: string[];
  /** 行选择变化回调 */
  onSelectedKeysChange?: (keys: string[]) => void;
}

/** 单 series 的数据 + 列结构（ResultTable 外层 useMemo 构建） */
interface TabItem {
  key: string;
  title: string;
  columns: MRT_ColumnDef<Record<string, unknown>>[];
  /** 时间列保留原始值（epoch ms 数字），其余列为字符串 */
  data: Record<string, unknown>[];
}

function buildRows(series: InfluxSeries) {
  const tagEntries = Object.entries(series.tags || {});
  return (series.values || []).map((row, idx) => {
    const obj: Record<string, unknown> = {};
    // 序号（从 1 开始），独立 dataIndex 避免与真实列名冲突
    obj.__row_index__ = String(idx + 1);
    tagEntries.forEach(([k, v]) => {
      obj[`#${k}`] = String(v);
    });
    series.columns.forEach((col, i) => {
      const v = row[i];
      // 时间列保留原始值（epoch ms 数字）：本地/UTC 切换只在渲染层对可见行做
      // formatCell，不再全量重建所有行（数万行切换瞬时完成）。
      // 其余列直接字符串化，省去每查数百万次无谓的 formatCell 调用。
      obj[col] = col === 'time' ? (v ?? '') : v == null ? '' : String(v);
    });
    return obj;
  });
}

/**
 * 按列名特征给出宽度，确保列标题能完整显示（不截断）。
 * 基础宽度按字符数估算：每个字符约 8px，加 padding 余量，并设最小/上限。
 */
function colWidth(key: string): number {
  if (key === 'time') return 180;
  // 按字符数估算：标题长度 × 8 + 24(padding)，最小 140，上限 360
  const byLen = Math.min(360, Math.max(140, key.length * 8 + 24));
  if (key.startsWith('#')) return Math.max(120, byLen);
  return byLen;
}

/** 固定左列的自定义 meta（MRT v2 无列 pinning API，用 CSS sticky 自实现） */
interface PinMeta {
  /** 固定列类型 */
  pinned?: 'left';
  /** 距滚动容器左缘的偏移（前面固定列宽之和） */
  offset?: number;
}

/** 构建 MRT 列：序号 + time 固定左列（CSS sticky），普通数据列全部 grow 均匀分布 */
function buildColumns(series: InfluxSeries): MRT_ColumnDef<Record<string, unknown>>[] {
  const tagKeys = Object.keys(series.tags || {}).map((k) => `#${k}`);
  const allKeys = [...tagKeys, ...series.columns];

  // 固定列：序号（56）+ time（180）依次排列，offset 累加
  const fixedCols: MRT_ColumnDef<Record<string, unknown>>[] = [];
  let fixedOffset = 0;
  fixedCols.push({
    accessorKey: '__row_index__',
    header: '#',
    size: 56,
    enableResizing: false,
    meta: { pinned: 'left', offset: fixedOffset } satisfies PinMeta,
  });
  fixedOffset += 56;
  if (allKeys.includes('time')) {
    fixedCols.push({
      accessorKey: 'time',
      header: 'time',
      size: 180,
      enableResizing: true,
      meta: { pinned: 'left', offset: fixedOffset } satisfies PinMeta,
    });
    fixedOffset += 180;
  }

  const dataKeys = allKeys.filter((key) => key !== 'time');
  const dataCols: MRT_ColumnDef<Record<string, unknown>>[] = dataKeys.map((key) => {
    return {
      accessorKey: key,
      header: key,
      size: colWidth(key),
      // 所有数据列都 grow：剩余宽度在所有查询字段间均匀铺满，
      // 避免只有最后一个字段被拉宽、其余保持窄列（呈现右侧“空列”）。
      grow: 1,
      enableResizing: true,
    };
  });

  return [...fixedCols, ...dataCols];
}

/**
 * 单 series 表格（MRT 虚拟化 + sticky 表头/固定列，水平滚动由浏览器 sticky 原生处理，无同步跳变）。
 * 选中状态下沉到本组件内部：点击行只触发本组件轻量重渲染，
 * 不再冒泡到 QueryEditor（那里挂着 CodeMirror 与工具栏）。
 */
function SingleMrTable({
  item,
  useUtc,
  selectedKeys,
  onSelectedKeysChange,
}: {
  item: TabItem;
  /** true=时间列显示 UTC，false=本地时间（渲染时格式化，不重建数据） */
  useUtc?: boolean;
  selectedKeys?: string[];
  onSelectedKeysChange?: (keys: string[]) => void;
}) {
  // 选中态写入 MRT 内置 rowSelection（table state 变化 → 行组件由 state 驱动重渲染，
  // data-selected / --row-bg 即时更新）。不用组件内 state + 行 props：MRT 的 table
  // instance 引用稳定，行 props 更新不会触发行组件重渲染，选中高亮会失效。
  const tableRef = useRef<MRT_TableInstance<Record<string, unknown>> | null>(null);

  // Shift 范围选的基准行（自定义逻辑，语义同原生表格）
  const lastIndexRef = useRef<number | null>(null);
  const handleRowClick = useCallback(
    (row: MRT_Row<Record<string, unknown>>, e: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }) => {
      const table = tableRef.current;
      if (!table) return;
      const idx = Number(row.original.__row_index__);
      const key = String(row.original.__row_index__);
      const current = new Set(Object.keys(table.getState().rowSelection));
      let nextKeys: string[];
      if (e.shiftKey && lastIndexRef.current !== null) {
        // Shift：选中上次点击行到当前行的连续范围
        const from = Math.min(lastIndexRef.current, idx);
        const to = Math.max(lastIndexRef.current, idx);
        nextKeys = [];
        for (let n = from; n <= to; n++) nextKeys.push(String(n));
      } else if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd：切换该行选中态（保留其他）
        if (current.has(key)) nextKeys = [...current].filter((k) => k !== key);
        else nextKeys = [...current, key];
      } else {
        // 普通点击：只选该行
        nextKeys = [key];
      }
      lastIndexRef.current = idx;
      table.setRowSelection(Object.fromEntries(nextKeys.map((k) => [k, true])));
      onSelectedKeysChange?.(nextKeys);
    },
    [onSelectedKeysChange],
  );

  // 外部 selectedKeys 变化（重新查询清空等）同步进 MRT 状态
  useEffect(() => {
    tableRef.current?.setRowSelection(
      Object.fromEntries((selectedKeys ?? []).map((k) => [k, true])),
    );
  }, [selectedKeys]);

  // 单元格右键：复制单元格 / 复制整行（value 已是显示层格式化后的文本；
  // 整行复制时 time 列按当前 本地/UTC 模式格式化，与界面一致）
  const handleCellContextMenu = useCallback(
    (record: Record<string, unknown>, value: string, e: React.MouseEvent) => {
      e.preventDefault();
      const rec = record;
      const val = value;
      showContextMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            key: 'copyCell',
            label: '复制单元格',
            onClick: () => {
              void navigator.clipboard.writeText(val).then(() => undefined);
            },
          },
          {
            key: 'copyRow',
            label: '复制整行',
            onClick: () => {
              const text = Object.entries(rec)
                .filter(([k]) => k !== '__row_index__')
                .map(([k, v]) => `${k}: ${k === 'time' ? formatCell(v, useUtc) : String(v)}`)
                .join('\n');
              void navigator.clipboard.writeText(text);
            },
          },
        ],
      });
    },
    [useUtc],
  );

  // 列：Cell 统一交互外壳（点击选行 + 右键复制）；固定列加 CSS sticky（MRT v2 无列 pinning）。
  // 时间列在此处按 useUtc 格式化（只影响可见行），数据行保持原始值 —— 切换 本地/UTC
  // 仅重建轻量的列配置，不重建数万行数据。
  const columns = useMemo<MRT_ColumnDef<Record<string, unknown>>[]>(
    () =>
      item.columns.map((col) => {
        const isIndex = col.accessorKey === '__row_index__';
        const isTime = col.accessorKey === 'time';
        const pinMeta = col.meta as PinMeta | undefined;
        const cellProps = pinMeta?.pinned
          ? {
              mantineTableHeadCellProps: {
                style: {
                  position: 'sticky' as const,
                  left: pinMeta.offset,
                  zIndex: 3,
                  background: 'var(--iv-bg-panel)',
                },
              },
              mantineTableBodyCellProps: {
                className: 'iv-table-sticky-cell',
                style: {
                  position: 'sticky' as const,
                  left: pinMeta.offset,
                  zIndex: 2,
                  // 背景不写 inline（会压过 MRT 的 hover 规则导致固定列 hover 不变色），
                  // 由 global.css 的 .iv-table-sticky-cell 提供：读 --row-bg 变量（选中态），
                  // hover 时被 MRT 的 tr:hover td 规则覆盖，两者都生效
                },
              },
            }
          : {};
        return {
          ...col,
          ...cellProps,
          Cell: ({ row, renderedCellValue }) => {
            const record = row.original;
            // 时间列：原始值 → 显示文本；其余列直接用渲染值
            const display = isTime
              ? formatCell(record['time'], useUtc)
              : String(renderedCellValue ?? '');
            return (
              <div
                style={{ cursor: 'pointer', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
                onClick={(e) => handleRowClick(row, e)}
                onContextMenu={(e) => handleCellContextMenu(record, display, e)}
                title={isIndex ? undefined : display}
              >
                {isTime ? (
                  // 时间列字号与其他列统一（Text 默认 16px，需显式指定与表格一致）
                  <Text style={{ fontFamily: 'monospace', fontSize: 14 }}>{display}</Text>
                ) : isIndex ? (
                  // 序号列颜色与其他列统一（不弱化，避免深浅不一）
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{display}</span>
                ) : (
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{display}</span>
                )}
              </div>
            );
          },
        };
      }),
    [item.columns, handleRowClick, handleCellContextMenu, useUtc],
  );

  const table = useMantineReactTable({
    data: item.data,
    columns,
    getRowId: (row) => String(row.__row_index__),
    enableRowVirtualization: true,
    // 显式 grid：不设时，因为 enableColumnResizing 未关闭，MRT 会把 layoutMode 推到
    // 'grid-no-grow'，该模式会追加一个 mrt-row-spacer 空列 —— 查询字段少时右侧出现空白列。
    // 固定 'grid'（行虚拟化所依赖的布局）：数据列 grow 后剩余宽度在所有字段间均匀铺满。
    layoutMode: 'grid',
    enableStickyHeader: true,
    enableColumnResizing: true,
    enableSorting: false,
    enableFilters: false,
    enableColumnActions: false,
    enableTopToolbar: false,
    enableBottomToolbar: false,
    enablePagination: false,
    enablePinning: false,
    // 内置 rowSelection：选中态存 table state（行组件由 state 驱动重渲染），
    // 高亮即时更新；隐藏默认的 checkbox 显示列（自定义点击语义已实现）
    enableRowSelection: true,
    enableColumnOrdering: false,
    enableDensityToggle: false,
    enableFullScreenToggle: false,
    enableHiding: false,
    enableGlobalFilter: false,
    // 关键性能项：MRT v2 beta 默认 memoMode 为 undefined，滚动时全部可见行+单元格
    // 每帧重渲染（无 memo）。'cells' 让单元格按引用 memo（cell 对象滚动时稳定，
    // 零重渲染）；行组件轻量重渲染（选中态 --row-bg 走行 props，即时更新——
    // 'rows' 模式会按 row 引用跳过行组件导致选中高亮失效，不可用）。
    memoMode: 'cells',
    initialState: { density: 'xs', columnVisibility: { 'mrt-row-select': false } },
    // 行高固定 45px（density 'xs' 实测 44.8），且单元格单行不换行：
    // 1) estimateSize 必须 >= 实际行高：虚拟化行按 estimateSize 间隔定位，
    //    若小于实际行高（此前 43 vs 44.8），每行与下一行重叠 1-3px，
    //    下一行的不透明背景会盖住上一行底部的横线（border/box-shadow 都不显示）
    // 2) measureElement 覆盖为常量：禁用 ResizeObserver 测量。否则每次新行挂载的
    //    测量结果写入缓存 → 连锁重算全部行位置 → 每帧 transform 更新（卡顿主源）
    rowVirtualizerOptions: {
      estimateSize: () => 45,
      measureElement: () => 45,
      overscan: 3,
    },
    // 表格撑满结果区剩余高度：paper flex:1 填满父容器，container flex:1 在其内部撑满，
    // 不再使用固定 scrollY，避免下方留空白、也不随窗口高度变化。
    mantinePaperProps: {
      style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
    },
    mantineTableContainerProps: {
      // maxHeight:100% 覆盖 MRT root-sticky 的 clamp(100vh-…，视口算，不跟随面板实际高度)
      style: { flex: 1, minHeight: 0, maxHeight: '100%' },
    },
    mantineTableProps: {
      style: { tableLayout: 'fixed' },
    },
    // 行背景通过 --row-bg CSS 变量驱动（sticky 固定列 td 读取同一变量，滚动时选中色不撕裂）；
    // 选中色直接读 MRT rowSelection state（行组件由 state 驱动重渲染，即时更新）
    mantineTableBodyRowProps: ({ row }) => {
      const selected = row.getIsSelected();
      const bg = selected
        ? 'light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-5))'
        : 'light-dark(var(--mantine-color-body), var(--mantine-color-dark-6))';
      return {
        style: {
          ['--row-bg' as string]: bg,
          ...(selected ? { background: bg } : null),
        } as React.CSSProperties,
      };
    },
    renderEmptyRowsFallback: () => (
      <Text c="dimmed" ta="center" py={24}>
        无数据
      </Text>
    ),
  });

  // 供 handleRowClick 读取（columns 在 table 创建前 useMemo，Cell 实际点击时已就绪）
  tableRef.current = table;

  return <MantineReactTable table={table} />;
}

export const ResultTable = memo(function ResultTable({ series, useUtc, selectedKeys, onSelectedKeysChange }: Props) {
  // 注意：useUtc 不参与行构建（时间列保留原始值，渲染时格式化），
  // 切换 本地/UTC 不会触发这里的全量重建
  const tabs = useMemo(() => {
    if (!series || series.length === 0) return [];
    return series.map((s, idx) => {
      const tagStr = s.tags
        ? ', ' + Object.entries(s.tags).map(([k, v]) => `${k}=${v}`).join(', ')
        : '';
      return {
        key: String(idx),
        title: `${s.name}${tagStr}`,
        columns: buildColumns(s),
        data: buildRows(s),
      };
    });
  }, [series]);

  if (!series || series.length === 0) {
    return (
      <Text c="dimmed" ta="center" py={40}>
        无数据
      </Text>
    );
  }

  // 仅单 series 时启用行选择（多 series 行索引跨 series 易混淆）
  if (tabs.length === 1) {
    return (
      <SingleMrTable
        item={tabs[0]}
        useUtc={useUtc}
        selectedKeys={selectedKeys}
        onSelectedKeysChange={onSelectedKeysChange}
      />
    );
  }

  return (
    <Tabs
      defaultValue={tabs[0]?.key}
      // 撑满结果区剩余高度：Tabs 纵向 flex，面板 flex:1，表格在面板内再撑满
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <Tabs.List style={{ flexShrink: 0 }}>
        {tabs.map((t) => (
          <Tabs.Tab key={t.key} value={t.key}>
            {t.title}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {tabs.map((t) => (
        <Tabs.Panel key={t.key} value={t.key} pt="sm" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <SingleMrTable item={t} useUtc={useUtc} />
        </Tabs.Panel>
      ))}
    </Tabs>
  );
});
