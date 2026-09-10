/**
 * 网络代理：应用内统一管理「不使用代理 / 使用系统代理 / 自定义代理」。
 *
 * 应用里有两条互不相通的网络通路，设置必须同时覆盖，否则会出现
 * 「数据库走代理、更新不走（或反之）」的割裂表现：
 *
 * 1) InfluxDB 请求 —— 主进程用 Node 的 http/https 直连 socket，Node 本身
 *    不认识系统代理。这里通过 Chromium 的 session.resolveProxy() 把系统代理
 *    （含 PAC/WPAD 脚本）解析出来，再为每个请求挑选对应的代理 Agent；
 * 2) 应用更新 —— electron-updater 用 Chromium 的 net 模块，且跑在独立会话
 *    分区 "electron-updater" 里（见 electron-updater 的 getNetSession），
 *    因此要对该分区单独 session.setProxy()；代理认证交给 app 的 login 事件。
 *
 * 另外：本机与局域网地址默认一律直连（见 isPrivateHost），避免内网数据库
 * 被绕到代理上；用户可在设置里显式开启 proxyPrivateNetworks 关闭该行为。
 */
import { app, safeStorage, session, type Session } from 'electron';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import type * as http from 'http';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type {
  ProxySettingsInput,
  ProxySettingsView,
  ProxyTestResult,
  SystemProxyInfo,
} from './types';

/** electron-updater 自建的网络会话分区名（与其 getNetSession 保持一致） */
const UPDATER_PARTITION = 'electron-updater';

/** 系统代理探针分区：固定「跟随系统」，只用于 resolveProxy 查询 */
const SYSTEM_PROBE_PARTITION = 'iv-system-proxy-probe';

/** 探测系统代理用的示例地址：PAC 脚本按 URL 决策，这里取向应用更新所在的域名，
 *  使展示出来的系统代理尽量贴近「检查更新」实际会走的链路 */
const PROBE_URL = 'https://github.com/';

/** 系统代理解析结果缓存时长：PAC 脚本按 URL 求值有开销，且每次 InfluxDB 请求
 *  都解析一次会明显放大延迟；30s 足够让「改了系统代理」及时生效 */
const SYSTEM_PROXY_TTL_MS = 30_000;

/** 代理连接（含握手/隧道）与 socket 空闲超时，与直连 Agent 保持一致的量级 */
const AGENT_TIMEOUT_MS = 30_000;

/** 代理 Agent 的连接池参数（与 influx.ts 里直连 Agent 的策略对齐） */
const AGENT_OPTIONS: http.AgentOptions = {
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 32,
  maxFreeSockets: 4,
  timeout: AGENT_TIMEOUT_MS,
};

/** 默认设置：跟随系统代理。
 *  这也是 Electron/Chromium 自身的默认行为 —— 升级前应用更新就走系统代理，
 *  默认值不改变这一点；而 InfluxDB 请求会跳过本机/局域网地址（见 isPrivateHost），
 *  所以内网数据库不会被绕远。 */
const DEFAULT_SETTINGS: ProxySettingsInput = {
  mode: 'system',
  protocol: 'http',
  host: '127.0.0.1',
  port: 7890,
  username: '',
  password: '',
  bypass: '',
  proxyPrivateNetworks: false,
};

/** 磁盘上的代理结构（密码为 safeStorage 密文，不落明文） */
interface StoredProxy extends Omit<ProxySettingsInput, 'password' | 'clearPassword'> {
  encryptedPassword?: string;
}

/**
 * Chromium 直连规则里默认要跳过的内网网段。Chromium 的 bypass 规则不支持
 * CIDR，只支持主机名通配，因此按前缀逐个列出（172.16/12 展开为 16 条）。
 */
const PRIVATE_BYPASS_RULES = [
  'localhost',
  '127.*',
  '10.*',
  '192.168.*',
  '169.254.*',
  ...Array.from({ length: 16 }, (_, i) => `172.${16 + i}.*`),
];

// ---- 内存状态 ----

/** 当前生效的代理设置（含解密后的密码，仅在主进程内存中） */
let currentSettings: ProxySettingsInput = { ...DEFAULT_SETTINGS };

/** 代理 Agent 缓存：key = `代理URL|目标协议`（协议不同 TLS 建立方式不同，必须分开） */
const agentCache = new Map<string, http.Agent>();

/** 系统代理解析缓存：key = 目标 origin */
const systemProxyCache = new Map<string, { at: number; url: string | null }>();

/** 已经尝试过代理认证的代理服务器，避免密码错误时 Chromium 反复弹认证导致死循环 */
const proxyAuthTried = new Set<string>();

let loginHandlerRegistered = false;

// ---- 密码加解密（与连接密码同策略：safeStorage，不可用时退化为带前缀的 base64）----

const PLAIN_PREFIX = 'plain:';

function encryptSecret(plain?: string): string | undefined {
  if (!plain) return undefined;
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.encryptString(plain).toString('base64');
    } catch {
      /* 落到下面的明文回退 */
    }
  }
  return `${PLAIN_PREFIX}${Buffer.from(plain, 'utf-8').toString('base64')}`;
}

function decryptSecret(encrypted?: string): string | undefined {
  if (!encrypted) return undefined;
  if (encrypted.startsWith(PLAIN_PREFIX)) {
    return Buffer.from(encrypted.slice(PLAIN_PREFIX.length), 'base64').toString('utf-8');
  }
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    return undefined;
  }
}

// ---- 磁盘持久化（userData/proxy.json）----

function proxyFile(): string {
  return path.join(app.getPath('userData'), 'proxy.json');
}

function readFromDisk(): ProxySettingsInput {
  try {
    const stored = JSON.parse(fs.readFileSync(proxyFile(), 'utf-8')) as Partial<StoredProxy>;
    const port = Number(stored.port);
    return {
      mode: stored.mode === 'none' || stored.mode === 'custom' ? stored.mode : 'system',
      protocol:
        stored.protocol === 'https' || stored.protocol === 'socks5' ? stored.protocol : 'http',
      host: typeof stored.host === 'string' && stored.host ? stored.host : DEFAULT_SETTINGS.host,
      port: Number.isFinite(port) && port > 0 && port <= 65535 ? port : DEFAULT_SETTINGS.port,
      username: typeof stored.username === 'string' ? stored.username : '',
      password: decryptSecret(stored.encryptedPassword) ?? '',
      bypass: typeof stored.bypass === 'string' ? stored.bypass : '',
      proxyPrivateNetworks: stored.proxyPrivateNetworks === true,
    };
  } catch {
    // 文件不存在 / 解析失败：用默认值（跟随系统代理）
    return { ...DEFAULT_SETTINGS };
  }
}

function writeToDisk(cfg: ProxySettingsInput): void {
  const stored: StoredProxy = {
    mode: cfg.mode,
    protocol: cfg.protocol,
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    bypass: cfg.bypass,
    proxyPrivateNetworks: cfg.proxyPrivateNetworks,
    encryptedPassword: encryptSecret(cfg.password),
  };
  const file = proxyFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(stored, null, 2), 'utf-8');
}

// ---- 工具函数 ----

/** IPv6 字面量在 URL 里必须带方括号 */
function formatHost(host: string): string {
  const h = host.trim().replace(/^\[|\]$/g, '');
  return net.isIPv6(h) ? `[${h}]` : h;
}

/** 直连名单解析：逗号 / 分号 / 空白分隔 */
function parseBypassList(bypass?: string): string[] {
  return (bypass || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 单个直连规则匹配（支持 `*` / `?` 通配、`*.example.com`、`<local>` 短名、host:port） */
function hostMatchesPattern(host: string, pattern: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const p = pattern.trim().toLowerCase().replace(/\[|\]/g, '');
  if (!p) return false;
  if (p === '*') return true;
  if (p === '<local>') return !h.includes('.');
  if (p.startsWith('*.')) return h === p.slice(2) || h.endsWith(p.slice(1));
  if (p.startsWith('.')) return h === p.slice(1) || h.endsWith(p);
  if (p.includes('*') || p.includes('?')) {
    const re = new RegExp(
      `^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
    );
    return re.test(h);
  }
  // 也接受 host:port 写法（端口部分不参与匹配）
  return h === p || h === p.split(':')[0];
}

/**
 * 是否属于「本机 / 局域网」地址。默认对这些地址直连，理由：
 * - 本机回环走代理毫无意义，且多数代理也不转发；
 * - 内网数据库（192.168.x.x 等）通常只有直连可达，走代理会直接连不上。
 * 非 IP 形式的短主机名（如 influxdb、nas）视为内网名。
 */
function isPrivateHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  const version = net.isIP(h);
  if (version === 4) {
    const [a, b] = h.split('.').map(Number);
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (version === 6) {
    if (h === '::1' || h === '::') return true;
    if (h.startsWith('fe80')) return true; // link-local
    if (/^f[cd]/.test(h)) return true; // ULA fc00::/7
    return false;
  }
  return !h.includes('.');
}

/** 由设置生成代理 URL（可带认证信息，供 Node Agent 使用）。
 *  SOCKS5 内部用 socks5h 语义（域名交给代理解析）：Clash / v2rayN 等需要
 *  拿到域名才能按规则分流，本地解析还会受 DNS 污染影响，与系统 SOCKS 代理
 *  在 Chromium 里的行为也一致。 */
function proxyUrlFromSettings(cfg: ProxySettingsInput): string {
  const scheme = cfg.protocol === 'socks5' ? 'socks5h' : cfg.protocol === 'https' ? 'https' : 'http';
  const auth = cfg.username
    ? `${encodeURIComponent(cfg.username)}:${encodeURIComponent(cfg.password ?? '')}@`
    : '';
  return `${scheme}://${auth}${formatHost(cfg.host)}:${cfg.port}`;
}

/** 把 Chromium resolveProxy 的返回串（如 "PROXY 127.0.0.1:7890"）转成代理 URL；
 *  DIRECT 或无法识别时返回 null。Chromium 不返回代理认证信息，
 *  系统代理若需认证请在设置里改用「自定义代理」。 */
function proxyUrlFromChromiumRule(raw: string): string | null {
  // 可能是多条规则（";" 分隔），取第一条
  for (const part of String(raw || '').split(';')) {
    const token = part.trim();
    if (!token) continue;
    const [kindRaw, addr] = token.split(/\s+/);
    const kind = (kindRaw || '').toUpperCase();
    if (kind === 'DIRECT') return null;
    if (!addr) continue;
    // Chromium 的 SOCKS5 同样是代理侧解析域名（socks5h）
    const scheme =
      kind === 'SOCKS5' || kind === 'SOCKS'
        ? 'socks5h'
        : kind === 'SOCKS4'
          ? 'socks4'
          : kind === 'HTTPS'
            ? 'https'
            : 'http';
    return `${scheme}://${addr}`;
  }
  return null;
}

/** 代理 URL 的可读描述，如 "127.0.0.1:7890 (HTTP)" */
function describeProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    const raw = u.protocol.replace(':', '').toUpperCase();
    // socks5h 只是实现细节（代理侧解析域名），展示上统一成 SOCKS5
    const scheme = raw === 'SOCKS5H' ? 'SOCKS5' : raw;
    const port =
      u.port || (scheme === 'HTTPS' ? '443' : scheme.startsWith('SOCKS') ? '1080' : '80');
    return `${u.hostname}:${port} (${scheme})`;
  } catch {
    return url;
  }
}

/** 目标地址是否命中用户配置的直连名单 */
function matchesBypass(host: string, bypass?: string): boolean {
  return parseBypassList(bypass).some((p) => hostMatchesPattern(host, p));
}

// ---- 代理 Agent（供 InfluxDB 请求使用）----

function createAgent(proxyUrl: string, secureTarget: boolean): http.Agent {
  // SOCKS（v8 起同时支持 socks4 / socks4a / socks5 / socks5h），
  // keepAlive 等连接池参数与 HTTP 代理一致，避免每次查询都重新握手
  if (proxyUrl.startsWith('socks')) return new SocksProxyAgent(proxyUrl, AGENT_OPTIONS);
  // HTTP 代理：明文目标走绝对 URI 请求（HttpProxyAgent），HTTPS 目标走 CONNECT 隧道
  return secureTarget
    ? new HttpsProxyAgent(proxyUrl, AGENT_OPTIONS)
    : new HttpProxyAgent(proxyUrl, AGENT_OPTIONS);
}

function cachedAgent(proxyUrl: string, secureTarget: boolean): http.Agent {
  const key = `${proxyUrl}|${secureTarget ? 'https' : 'http'}`;
  const hit = agentCache.get(key);
  if (hit) return hit;
  const agent = createAgent(proxyUrl, secureTarget);
  // 缓存上限很小：正常只会出现 1~2 个代理 × 目标协议；超限按插入顺序淘汰最旧的
  if (agentCache.size >= 8) {
    const oldest = agentCache.keys().next().value;
    if (oldest) {
      agentCache.get(oldest)?.destroy();
      agentCache.delete(oldest);
    }
  }
  agentCache.set(key, agent);
  return agent;
}

/**
 * 系统代理探针会话：始终强制「跟随系统」，因此与当前应用设置无关。
 *
 * 不能用 defaultSession 代替 —— 用户一旦选了「自定义代理」或「不使用代理」，
 * 默认会话的代理已被我们改写，再拿它 resolveProxy 只会读到我们自己的规则
 * （展示出来的"系统代理"和实际解析结果都会是错的）。
 */
let systemProbeSession: Session | null = null;

function systemProbe(): Session {
  if (!systemProbeSession) {
    systemProbeSession = session.fromPartition(SYSTEM_PROBE_PARTITION, { cache: false });
    // 新建分区本就是跟随系统，这里显式设置以免受历史状态影响
    void systemProbeSession.setProxy({ mode: 'system' }).catch(() => {});
  }
  return systemProbeSession;
}

/** 解析系统代理（带缓存）。返回 null 表示直连。 */
async function resolveSystemProxyUrl(targetUrl: string): Promise<string | null> {
  let origin = targetUrl;
  try {
    origin = new URL(targetUrl).origin;
  } catch {
    /* 非法 URL 就按原串做 key */
  }
  const hit = systemProxyCache.get(origin);
  if (hit && Date.now() - hit.at < SYSTEM_PROXY_TTL_MS) return hit.url;
  let raw = 'DIRECT';
  try {
    raw = await systemProbe().resolveProxy(targetUrl);
  } catch {
    /* 解析失败按直连，避免把请求整挂掉 */
  }
  const url = proxyUrlFromChromiumRule(raw);
  systemProxyCache.set(origin, { at: Date.now(), url });
  return url;
}

/**
 * 为一次 InfluxDB 请求挑选代理 Agent。
 * 返回 undefined 表示直连（由调用方使用共享的直连 Agent）。
 */
export async function getProxyAgentForUrl(targetUrl: string): Promise<http.Agent | undefined> {
  const cfg = currentSettings;
  if (cfg.mode === 'none') return undefined;

  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return undefined;
  }
  const host = target.hostname;
  if (!cfg.proxyPrivateNetworks && isPrivateHost(host)) return undefined;
  if (matchesBypass(host, cfg.bypass)) return undefined;

  const proxyUrl =
    cfg.mode === 'custom' ? proxyUrlFromSettings(cfg) : await resolveSystemProxyUrl(targetUrl);
  if (!proxyUrl) return undefined;
  return cachedAgent(proxyUrl, target.protocol === 'https:');
}

// ---- 下发到 Chromium 会话（应用更新等走 net 模块的请求）----

function proxySessions(): Session[] {
  const list: Session[] = [session.defaultSession];
  try {
    // 与应用更新保持同一分区（分区按名字缓存，先创建不影响 electron-updater 后续取用）
    list.push(session.fromPartition(UPDATER_PARTITION, { cache: false }));
  } catch {
    /* 取不到则该通路沿用系统默认，不影响主流程 */
  }
  return list;
}

/** Chromium 代理规则（不支持内嵌账号密码，认证走 app 的 login 事件） */
function chromiumProxyRules(cfg: ProxySettingsInput): string {
  const scheme = cfg.protocol === 'socks5' ? 'socks5' : cfg.protocol === 'https' ? 'https' : 'http';
  return `${scheme}://${formatHost(cfg.host)}:${cfg.port}`;
}

function chromiumBypassRules(cfg: ProxySettingsInput): string {
  const rules = ['<local>', 'localhost', '127.0.0.1', '::1'];
  if (!cfg.proxyPrivateNetworks) rules.push(...PRIVATE_BYPASS_RULES);
  rules.push(...parseBypassList(cfg.bypass));
  return Array.from(new Set(rules)).join(',');
}

async function applyToSessions(cfg: ProxySettingsInput): Promise<void> {
  // 注意：mode 与 proxyRules 不能同时下发
  const proxies =
    cfg.mode === 'custom'
      ? { proxyRules: chromiumProxyRules(cfg), proxyBypassRules: chromiumBypassRules(cfg) }
      : { mode: (cfg.mode === 'system' ? 'system' : 'direct') as 'system' | 'direct' };

  const errors: Error[] = [];
  for (const ses of proxySessions()) {
    try {
      await ses.setProxy(proxies);
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
  }
  if (errors.length) throw errors[0];
}

/** 代理认证：Chromium 侧（net 模块 / 渲染层）遇到 407 时由这里补上凭据 */
function registerLoginHandler(): void {
  if (loginHandlerRegistered) return;
  loginHandlerRegistered = true;
  app.on('login', (event, _webContents, _details, authInfo, callback) => {
    if (!authInfo?.isProxy) return; // 只接管代理认证，站点认证交回默认行为
    const cfg = currentSettings;
    if (cfg.mode !== 'custom' || !cfg.username) return;
    const key = `${authInfo.host}:${authInfo.port}`;
    if (proxyAuthTried.has(key)) return; // 已试过一次，密码错就别再来回弹
    proxyAuthTried.add(key);
    event.preventDefault();
    callback(cfg.username, cfg.password ?? '');
  });
}

/** 配置变化后清理所有派生缓存（Agent 连接池、系统代理解析、认证尝试记录） */
function invalidateCaches(): void {
  for (const agent of agentCache.values()) {
    try {
      agent.destroy();
    } catch {
      /* 关闭失败忽略 */
    }
  }
  agentCache.clear();
  systemProxyCache.clear();
  proxyAuthTried.clear();
}

/** 把表单输入合并成完整设置：密码留空表示沿用已保存的密码 */
function normalizeInput(input: ProxySettingsInput, prev: ProxySettingsInput): ProxySettingsInput {
  return {
    mode: input.mode === 'none' || input.mode === 'custom' ? input.mode : 'system',
    protocol:
      input.protocol === 'https' || input.protocol === 'socks5' ? input.protocol : 'http',
    host: (input.host ?? '').trim(),
    port: Number(input.port) || 0,
    username: (input.username ?? '').trim(),
    password: input.clearPassword ? '' : input.password ? input.password : prev.password,
    bypass: input.bypass ?? '',
    proxyPrivateNetworks: input.proxyPrivateNetworks === true,
  };
}

function toView(cfg: ProxySettingsInput): ProxySettingsView {
  const { password, clearPassword, ...rest } = cfg;
  void clearPassword;
  return { ...rest, hasPassword: !!password };
}

// ---- 对外 API ----

/** 读取当前代理设置（密码不外泄，只告知是否已保存） */
export function getProxySettings(): ProxySettingsView {
  return toView(currentSettings);
}

/** 应用启动时调用：载入磁盘设置并下发到会话 */
export async function initProxy(): Promise<void> {
  currentSettings = readFromDisk();
  registerLoginHandler();
  invalidateCaches();
  try {
    await applyToSessions(currentSettings);
  } catch {
    // 启动阶段下发失败不阻塞应用启动：保持系统默认，用户可在设置里改
  }
}

/** 保存代理设置并立即生效（InfluxDB 请求与应用更新同时切换） */
export async function saveProxySettings(input: ProxySettingsInput): Promise<ProxySettingsView> {
  const next = normalizeInput(input, currentSettings);
  if (next.mode === 'custom') {
    if (!next.host) throw new Error('请填写代理服务器地址');
    if (!next.port || next.port < 1 || next.port > 65535) throw new Error('代理端口需在 1-65535 之间');
  }
  // 先下发（规则非法时 setProxy 会抛错，此时不落盘），失败则回滚到原设置
  try {
    await applyToSessions(next);
  } catch (err) {
    await applyToSessions(currentSettings).catch(() => {});
    throw err instanceof Error ? err : new Error(String(err));
  }
  currentSettings = next;
  writeToDisk(next);
  invalidateCaches();
  return toView(next);
}

/** 探测系统代理（设置界面展示用）。读的是独立探针分区，与当前设置无关。 */
export async function getSystemProxyInfo(): Promise<SystemProxyInfo> {
  let raw = 'DIRECT';
  try {
    raw = await systemProbe().resolveProxy(PROBE_URL);
  } catch {
    /* 探测失败按直连展示 */
  }
  const url = proxyUrlFromChromiumRule(raw);
  return {
    direct: !url,
    raw,
    display: url ? describeProxyUrl(url) : '未检测到系统代理（直连）',
  };
}

/** TCP 建连探测（用于「测试代理」） */
function probeTcp(host: string, port: number, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let settled = false;
    const socket = net.connect({ host, port });
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(Date.now() - start);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish());
    socket.once('timeout', () => finish(new Error('连接超时')));
    socket.once('error', (err) => finish(err instanceof Error ? err : new Error(String(err))));
  });
}

/** 测试代理服务器连通性（TCP 可达性，不含认证校验） */
export async function testProxy(input: ProxySettingsInput): Promise<ProxyTestResult> {
  const cfg = normalizeInput(input, currentSettings);
  if (cfg.mode === 'none') {
    return { ok: true, message: '当前为「不使用代理」，所有请求将直连。' };
  }

  let proxyUrl: string | null;
  if (cfg.mode === 'custom') {
    if (!cfg.host) return { ok: false, message: '请填写代理服务器地址' };
    if (!cfg.port || cfg.port < 1 || cfg.port > 65535) {
      return { ok: false, message: '代理端口需在 1-65535 之间' };
    }
    proxyUrl = proxyUrlFromSettings(cfg);
  } else {
    proxyUrl = await resolveSystemProxyUrl(PROBE_URL);
    if (!proxyUrl) return { ok: true, message: '系统未配置代理，请求将直连。' };
  }

  let host = '';
  let port = 0;
  try {
    const u = new URL(proxyUrl);
    host = u.hostname;
    port =
      Number(u.port) ||
      (u.protocol === 'https:' ? 443 : u.protocol.startsWith('socks') ? 1080 : 80);
  } catch {
    return { ok: false, message: `代理地址无法解析：${proxyUrl}` };
  }

  try {
    const latencyMs = await probeTcp(host, port, 5000);
    return {
      ok: true,
      message: `代理服务器可达：${formatHost(host)}:${port}`,
      latencyMs,
    };
  } catch (err) {
    return {
      ok: false,
      message: `无法连接代理服务器 ${formatHost(host)}:${port}：${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}
