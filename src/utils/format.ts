/**
 * 时间/单元格格式化工具。表格展示（ResultTable）与导出（exporter）共用，
 * 确保导出的时间格式与界面显示一致。
 */

/** 把 Date 格式化为本地 yyyy-MM-dd HH:mm:ss */
export function toLocalString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 把 RFC3339 时间或 epoch 数字格式化为可读时间。
 * useUtc=true 时显示 UTC 原始时间（用 toISOString 的本地段，不转时区），
 * 否则显示本地时间（yyyy-MM-dd HH:mm:ss）。
 *
 * 兼容 InfluxDB 常见时间格式：
 * - RFC3339 字符串：2024-01-01T08:00:00Z
 * - 纳秒 epoch（>1e15）：1700000000000000000
 * - 毫秒 epoch（>1e12）：1700000000000
 * - 其他字符串/数字：原样返回
 */
export function formatCell(value: unknown, useUtc = false): string {
  if (value === null || value === undefined) return '';
  const fmt = (d: Date) =>
    useUtc
      ? d.toISOString().slice(0, 19).replace('T', ' ') // 精确到秒，如 2024-01-01 08:00:00
      : toLocalString(d);
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return fmt(d);
    }
    return value;
  }
  if (typeof value === 'number') {
    if (value > 1e15) {
      const d = new Date(Math.floor(value / 1e6));
      return fmt(d);
    }
    if (value > 1e12) {
      const d = new Date(value);
      return fmt(d);
    }
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(value);
}
