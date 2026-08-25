/**
 * 渲染层类型导出 —— 复用主进程定义的共享类型，
 * 避免类型重复维护。编译时由 tsconfig 路径解析。
 */
export type {
  ConnectionConfig,
  ConnectionForm,
  InfluxSeries,
  InfluxQueryResponse,
  PingResult,
  QueryRequest,
  WriteRequest,
  WriteResult,
  SavedQuery,
  InfluxViewApi,
  UpdateCheckResult,
  UpdateProgress,
  UpdateDownloaded,
  AppUpdaterApi,
} from '../../electron/types';

/** 把 InfluxDB 错误体（JSON 或原文）解析成可读消息 */
function parseErrorBody(body: string): string {
  try {
    const json = JSON.parse(body);
    if (json.error) return json.error;
    if (Array.isArray(json.results)) {
      for (const r of json.results) {
        if (r?.error) return r.error;
      }
    }
  } catch {
    /* 非 JSON，返回原文 */
  }
  return body;
}

/**
 * 渲染进程访问 preload 暴露的 API 的统一入口。
 * query 在这里（渲染层主世界）解析原始 body：
 * - 主进程不再 JSON.parse，IPC / contextBridge 只克隆单个字符串；
 * - 大结果集省掉「主进程 parse + IPC 对象树克隆」两段开销，只 parse 一次。
 * 其余方法原样透传。
 */
export function getApi(): import('../../electron/types').InfluxViewApi {
  const api = (window as unknown as { influxView: import('../../electron/types').InfluxViewApi })
    .influxView;
  return {
    ...api,
    query: async (req) => {
      const { statusCode, body } = await api.queryRaw(req);
      if (statusCode >= 400) {
        throw new Error(parseErrorBody(body) || `HTTP ${statusCode}`);
      }
      return JSON.parse(body) as import('../../electron/types').InfluxQueryResponse;
    },
  };
}

/**
 * 应用更新 API（preload 的 appUpdater）。
 * 纯浏览器环境（无 Electron preload）时返回 null，调用方需判空。
 */
export function getUpdaterApi(): import('../../electron/types').AppUpdaterApi | null {
  if (typeof window === 'undefined') return null;
  return (
    (window as unknown as { appUpdater?: import('../../electron/types').AppUpdaterApi }).appUpdater ||
    null
  );
}
