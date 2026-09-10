/**
 * 主进程与渲染进程共享的类型定义
 * 渲染进程通过 `@/types` 别名引用，主进程直接相对引用
 */

/** 一条已保存的连接配置（密码字段以加密形式存储于磁盘） */
export interface ConnectionConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username?: string;
  /** 加密存储后的密码密文，传输到渲染层前会被清空 */
  password?: string;
  /** 默认数据库 */
  database?: string;
  /** 是否启用 HTTPS */
  tls: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 用户在表单里编辑的连接配置（密码为明文） */
export type ConnectionForm = Omit<ConnectionConfig, 'id' | 'createdAt' | 'updatedAt'>;

/** InfluxDB /ping 结果 */
export interface PingResult {
  version: string;
  /** 响应耗时（毫秒） */
  latencyMs: number;
}

/** InfluxQL 查询返回的单个 series */
export interface InfluxSeries {
  name: string;
  tags?: Record<string, string>;
  columns: string[];
  values: unknown[][];
}

/** /query 端点响应结构（可能含 error） */
export interface InfluxQueryResponse {
  results: Array<{
    statement_id?: number;
    error?: string;
    series?: InfluxSeries[];
    messages?: Array<{ level: string; text: string }>;
  }>;
  error?: string;
}

/** /write 端点结果 */
export interface WriteResult {
  ok: boolean;
  statusCode: number;
}

/** 统一错误返回（主进程抛出的错误会包装成此结构） */
export interface IpcError {
  message: string;
  /** InfluxDB 返回的错误文本 */
  influxError?: string;
  statusCode?: number;
}

/** 查询请求参数 */
export interface QueryRequest {
  connectionId: string;
  /** 目标数据库（USE 在 HTTP API 不可用，必须传 db） */
  database?: string;
  /** InfluxQL 语句 */
  query: string;
  /** 是否按 epoch 返回时间，默认 false（RFC3339） */
  epoch?: 'ns' | 'u' | 'ms' | 's' | 'm' | 'h';
}

/** 写入请求参数 */
export interface WriteRequest {
  connectionId: string;
  database: string;
  /** Line Protocol 文本 */
  lines: string;
  /** 保留策略，可选 */
  retentionPolicy?: string;
}

/** 用户主动收藏的查询语句（按连接隔离，持久化到磁盘） */
export interface SavedQuery {
  id: string;
  /** 所属连接 id，用于按连接过滤 */
  connectionId: string;
  /** 用户起的名字，默认取 SQL 前 30 字 */
  title: string;
  sql: string;
  /** 保存时所在的库，可选 */
  database?: string;
  createdAt: number;
}

// ---- 网络代理 ----

/** 代理模式：不使用代理 / 跟随系统代理 / 自定义代理 */
export type ProxyMode = 'none' | 'system' | 'custom';

/** 自定义代理的协议（socks5 适用于 Clash / v2rayN 等只开 SOCKS 端口的场景） */
export type ProxyProtocol = 'http' | 'https' | 'socks5';

/** 代理设置（表单输入结构，password 为明文，仅在提交时跨进程传递） */
export interface ProxySettingsInput {
  mode: ProxyMode;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  /** 明文密码；留空表示沿用已保存的密码（需要清除时用 clearPassword） */
  password?: string;
  /** 置为 true 表示清空已保存的密码 */
  clearPassword?: boolean;
  /** 直连名单：逗号 / 分号 / 空白分隔，支持 *.example.com 与 * 通配 */
  bypass?: string;
  /** 局域网与本机地址是否也走代理（默认 false：自动直连，避免拖慢内网连接） */
  proxyPrivateNetworks?: boolean;
}

/** 代理设置（渲染层读取结构：不含密码明文，仅告知是否已保存密码） */
export interface ProxySettingsView extends Omit<ProxySettingsInput, 'password' | 'clearPassword'> {
  hasPassword: boolean;
}

/** 系统代理探测结果（设置界面展示用） */
export interface SystemProxyInfo {
  /** 系统未配置代理（直连） */
  direct: boolean;
  /** Chromium 原始返回值，如 "PROXY 127.0.0.1:7890" / "DIRECT" */
  raw: string;
  /** 便于阅读的展示文本，如 "127.0.0.1:7890 (HTTP)" */
  display: string;
}

/** 代理连通性测试结果 */
export interface ProxyTestResult {
  ok: boolean;
  /** 结果描述（成功或失败原因） */
  message: string;
  /** 到代理服务器的 TCP 建连耗时（毫秒） */
  latencyMs?: number;
}

/** 检查更新的结果 */
export interface UpdateCheckResult {
  /** 是否有新版本 */
  available: boolean;
  /** 新版本号（无更新时为 null） */
  version: string | null;
  /** 当前应用版本号 */
  currentVersion: string;
  /** 发布说明（GitHub Release 正文，Markdown 文本） */
  releaseNotes: string | null;
  /** 新版本的 Release 页面链接 */
  releaseUrl: string | null;
  /** 失败时的错误信息（如网络不可达） */
  error?: string;
  /** 便携版：不支持应用内更新（主进程检测 PORTABLE_EXECUTABLE_DIR 后置位） */
  portable?: boolean;
  /** 开发环境（未打包）：不发起更新检查，界面据此提示 */
  dev?: boolean;
}

/** 下载进度（update:progress 事件载荷） */
export interface UpdateProgress {
  /** 0-100 */
  percent: number;
  /** 已下载字节 */
  transferred: number;
  /** 总字节 */
  total: number;
  /** 下载速度（字节/秒） */
  bytesPerSecond: number;
}

/** 下载完成（update:downloaded 事件载荷） */
export interface UpdateDownloaded {
  version: string;
}

/** preload 暴露的应用更新 API（与业务 API 分离） */
export interface AppUpdaterApi {
  /** 当前应用版本号（package.json version） */
  getVersion: () => Promise<string>;
  /** 检查更新 */
  check: () => Promise<UpdateCheckResult>;
  /** 下载更新（进度经 onProgress 推送） */
  download: () => Promise<{ ok: boolean; error?: string }>;
  /** 退出并安装已下载的更新 */
  install: () => void;
  /** 订阅下载进度，返回取消订阅函数 */
  onProgress: (cb: (p: UpdateProgress) => void) => () => void;
  /** 订阅下载完成，返回取消订阅函数 */
  onDownloaded: (cb: (info: UpdateDownloaded) => void) => () => void;
}

/** preload 通过 contextBridge 暴露给渲染进程的 API */
export interface InfluxViewApi {
  // 连接管理
  listConnections: () => Promise<ConnectionConfig[]>;
  saveConnection: (form: ConnectionForm & { id?: string }) => Promise<ConnectionConfig>;
  deleteConnection: (id: string) => Promise<void>;
  testConnection: (form: ConnectionForm) => Promise<PingResult>;

  // InfluxDB 操作
  ping: (connectionId: string) => Promise<PingResult>;
  /** 原始查询：返回 HTTP 状态码 + 未解析的 JSON 字符串（渲染层解析一次，避免跨进程克隆对象树） */
  queryRaw: (req: QueryRequest) => Promise<{ statusCode: number; body: string }>;
  /** 解析后的查询（便捷方法；性能敏感路径建议直接用 queryRaw） */
  query: (req: QueryRequest) => Promise<InfluxQueryResponse>;
  write: (req: WriteRequest) => Promise<WriteResult>;

  // 主题持久化
  getTheme: () => Promise<'light' | 'dark' | 'system'>;
  setTheme: (theme: 'light' | 'dark' | 'system') => Promise<void>;

  // 网络代理
  /** 读取当前代理设置（不返回密码明文） */
  getProxySettings: () => Promise<ProxySettingsView>;
  /** 保存代理设置（立即对 InfluxDB 请求与应用更新生效） */
  saveProxySettings: (cfg: ProxySettingsInput) => Promise<ProxySettingsView>;
  /** 探测系统代理（Windows「Internet 选项」/ macOS 网络设置中的代理） */
  getSystemProxy: () => Promise<SystemProxyInfo>;
  /** 测试代理服务器连通性（TCP 可达性） */
  testProxy: (cfg: ProxySettingsInput) => Promise<ProxyTestResult>;

  // 收藏查询持久化（按连接隔离）
  /** 读取某连接下的全部收藏查询 */
  listSavedQueries: (connectionId: string) => Promise<SavedQuery[]>;
  /** 新增或更新收藏查询（按 id upsert） */
  saveSavedQuery: (item: SavedQuery) => Promise<void>;
  /** 删除收藏查询 */
  deleteSavedQuery: (id: string) => Promise<void>;
}
