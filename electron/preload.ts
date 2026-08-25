import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { InfluxViewApi, AppUpdaterApi } from './types';

/**
 * preload 在隔离环境中运行，仅通过 contextBridge 暴露白名单方法。
 * 渲染层无法直接访问 Node / ipcRenderer，只能调用此处的 API。
 */
/** 把 InfluxDB 错误体（JSON 或原文）解析成可读消息（与主进程 write 路径同逻辑） */
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

const api: InfluxViewApi = {
  // 连接管理
  listConnections: () => ipcRenderer.invoke('connection:list'),
  saveConnection: (form) => ipcRenderer.invoke('connection:save', form),
  deleteConnection: (id) => ipcRenderer.invoke('connection:delete', id),
  testConnection: (form) => ipcRenderer.invoke('connection:test', form),

  // InfluxDB 操作
  ping: (connectionId) => ipcRenderer.invoke('influx:ping', connectionId),
  // 原始查询：body 保持字符串跨桥传输（字符串克隆远快于对象树），由渲染层解析一次
  queryRaw: (req) => ipcRenderer.invoke('influx:query', req),
  query: async (req) => {
    const { statusCode, body } = await ipcRenderer.invoke('influx:query', req);
    if (statusCode >= 400) {
      throw new Error(parseErrorBody(body) || `HTTP ${statusCode}`);
    }
    return JSON.parse(body);
  },
  write: (req) => ipcRenderer.invoke('influx:write', req),

  // 主题
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),

  // 收藏查询（按连接隔离）
  listSavedQueries: (connectionId) => ipcRenderer.invoke('saved:list', connectionId),
  saveSavedQuery: (item) => ipcRenderer.invoke('saved:upsert', item),
  deleteSavedQuery: (id) => ipcRenderer.invoke('saved:delete', id),
};

contextBridge.exposeInMainWorld('influxView', api);

/** 窗口控制 API（自绘标题栏使用）。与业务 API 分开，避免耦合。 */
const windowApi = {
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  close: () => ipcRenderer.send('window:close'),
  /** 订阅最大化状态变化，返回取消订阅函数 */
  onMaximizedChange: (cb: (maximized: boolean) => void) => {
    const handler = (_e: IpcRendererEvent, maximized: boolean) => cb(maximized);
    ipcRenderer.on('window:maximized', handler);
    return () => ipcRenderer.removeListener('window:maximized', handler);
  },
};

contextBridge.exposeInMainWorld('windowControls', windowApi);

/** 应用更新 API（与业务/窗口 API 分离） */
const updaterApi: AppUpdaterApi = {
  getVersion: () => ipcRenderer.invoke('updater:getVersion'),
  check: () => ipcRenderer.invoke('updater:check'),
  download: () => ipcRenderer.invoke('updater:download'),
  install: () => ipcRenderer.send('updater:install'),
  onProgress: (cb) => {
    const handler = (_e: IpcRendererEvent, p: Parameters<typeof cb>[0]) => cb(p);
    ipcRenderer.on('updater:progress', handler);
    return () => ipcRenderer.removeListener('updater:progress', handler);
  },
  onDownloaded: (cb) => {
    const handler = (_e: IpcRendererEvent, info: Parameters<typeof cb>[0]) => cb(info);
    ipcRenderer.on('updater:downloaded', handler);
    return () => ipcRenderer.removeListener('updater:downloaded', handler);
  },
};

contextBridge.exposeInMainWorld('appUpdater', updaterApi);
