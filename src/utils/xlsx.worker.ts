/// <reference lib="webworker" />

/**
 * xlsx 导出 Worker：XLSX.utils + XLSX.write 在子线程执行，
 * 大结果集（数万~数十万行）导出不再冻结 UI。
 * 以 ?worker&inline 方式打包（Blob URL 加载），Electron file:// 协议下同样可用。
 */
import * as XLSX from 'xlsx';

interface ExportRequest {
  rows: Record<string, unknown>[];
}

interface ExportOk {
  ok: true;
  /** xlsx 文件内容（ArrayBuffer，transferable 回传零拷贝） */
  data: ArrayBuffer;
}

interface ExportErr {
  ok: false;
  error: string;
}

self.onmessage = (e: MessageEvent<ExportRequest>) => {
  try {
    const ws = XLSX.utils.json_to_sheet(e.data.rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '结果');
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
    (self as unknown as Worker).postMessage({ ok: true, data: out } satisfies ExportOk, [out]);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies ExportErr);
  }
};
