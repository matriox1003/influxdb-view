import type { InfluxSeries } from '../types';
import { formatCell } from './format';

/** 导出选项 */
export type ExportFormat = 'xlsx' | 'json';

/**
 * 把 InfluxDB series 数组拍平成 [{列名: 值}, ...] 的行数据（含 tags 前缀）。
 * time 列经 formatCell 格式化为可读时间，与表格显示保持一致；
 * useUtc=true 导出 UTC 时间，否则本地时间。
 * 不附加 __measurement__（表名）列 —— Excel / JSON 导出的表格里都不出现表名。
 */
export function seriesToRows(
  series: InfluxSeries[],
  useUtc = false,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const s of series) {
    const tagEntries = Object.entries(s.tags || {});
    (s.values || []).forEach((row, idx) => {
      const obj: Record<string, unknown> = {};
      // 供「导出选中」按结果表格行号筛选（与 ResultTable.buildRows 的 __row_index__ 一致）；
      // 它是内部过滤用的元数据，会在写文件前被 stripRowIndex 移除，不会出现在导出里。
      obj.__row_index__ = String(idx + 1);
      tagEntries.forEach(([k, v]) => {
        obj[`#${k}`] = v;
      });
      s.columns.forEach((col, i) => {
        // time 列格式化，其余列原样保留（数值/字符串导出更通用）
        obj[col] = col === 'time' ? formatCell(row[i], useUtc) : row[i];
      });
      rows.push(obj);
    });
  }
  return rows;
}

/** 移除仅用于内部过滤的 __row_index__，避免它作为一个数据列出现在导出文件里 */
function stripRowIndex(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  for (const r of rows) delete r.__row_index__;
  return rows;
}

/** 触发浏览器下载（用 Blob + a 标签） */
function downloadBlob(content: BlobPart, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 延迟释放，避免某些浏览器下载未完成
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 时间戳文件名：query-result-20260704-153000 */
function tsName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 主线程回退路径：直接构建 xlsx（Worker 不可用时） */
async function buildXlsxInline(rows: Record<string, unknown>[]): Promise<ArrayBuffer> {
  const XLSX = await import('xlsx');
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '结果');
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
}

/**
 * 在 inline Worker 中构建 xlsx：XLSX.write 对大结果集是秒级 CPU 密集操作，
 * 移出主线程避免导出期间 UI 冻结。Worker 初始化/执行失败时回退主线程。
 * ?worker&inline 打包为 Blob URL，Electron file:// 协议下同样可用。
 */
async function buildXlsx(rows: Record<string, unknown>[]): Promise<ArrayBuffer> {
  try {
    const { default: XlsxWorker } = await import('./xlsx.worker?worker&inline');
    const worker = new XlsxWorker();
    try {
      return await new Promise<ArrayBuffer>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent) => {
          if (e.data?.ok) resolve(e.data.data as ArrayBuffer);
          else reject(new Error(e.data?.error || 'xlsx worker failed'));
        };
        worker.onerror = () => reject(new Error('xlsx worker error'));
        worker.postMessage({ rows });
      });
    } finally {
      worker.terminate();
    }
  } catch {
    // Worker 不可用（构建/环境异常）：回退主线程同步构建
    return buildXlsxInline(rows);
  }
}

/** 导出为 Excel（.xlsx）—— 构建在 Worker 中执行，xlsx 本体按需动态加载 */
export async function exportToXlsx(series: InfluxSeries[], selectedRowKeys?: Set<string>, useUtc = false) {
  const allRows = seriesToRows(series, useUtc);
  // 支持部分导出：按行的 __row_index__（与表格 rowKey 一致）过滤，避免分页下标错位
  const rows =
    selectedRowKeys && selectedRowKeys.size > 0
      ? allRows.filter((r) => r.__row_index__ !== undefined && selectedRowKeys.has(String(r.__row_index__)))
      : allRows;
  if (rows.length === 0) return;
  // 移除过滤用的 __row_index__，确保导出表格里不出现这列
  stripRowIndex(rows);

  const wbout = await buildXlsx(rows);
  downloadBlob(wbout, `query-result-${tsName()}.xlsx`, 'application/octet-stream');
}

/** 导出为 JSON */
export function exportToJson(series: InfluxSeries[], selectedRowKeys?: Set<string>, useUtc = false) {
  const allRows = seriesToRows(series, useUtc);
  const rows =
    selectedRowKeys && selectedRowKeys.size > 0
      ? allRows.filter((r) => r.__row_index__ !== undefined && selectedRowKeys.has(String(r.__row_index__)))
      : allRows;
  if (rows.length === 0) return;
  // 移除过滤用的 __row_index__（表名 __measurement__ 已不生成，JSON 同样不含表名）
  stripRowIndex(rows);
  downloadBlob(JSON.stringify(rows, null, 2), `query-result-${tsName()}.json`, 'application/json');
}
