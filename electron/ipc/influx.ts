import { app, ipcMain } from 'electron';
import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import type {
  ConnectionConfig,
  PingResult,
  QueryRequest,
  WriteRequest,
  WriteResult,
} from '../types';
import { getConfigById } from './connection';

/** 用于直接发请求的最小连接信息（既可来自已保存配置，也可来自表单） */
export interface RequestConn {
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls: boolean;
}

function normalizeHost(host: string): string {
  return host.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function buildBaseUrl(c: RequestConn): string {
  const scheme = c.tls ? 'https' : 'http';
  return `${scheme}://${normalizeHost(c.host)}:${c.port}`;
}

/** 把 InfluxDB 错误体解析成可读消息 */
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

function basicAuth(c: RequestConn): string | undefined {
  if (!c.username) return undefined;
  const token = Buffer.from(`${c.username}:${c.password ?? ''}`, 'utf-8').toString('base64');
  return `Basic ${token}`;
}

/**
 * 复用 TCP 连接的全局共享 Agent：http / https 各一个（TLS 建立方式不同，必须分开）。
 * Node 的 Agent 内部本就按 host:port 分组管理 socket，单个实例即可服务所有连接，
 * 无需按连接创建 —— 旧实现按 host:port 缓存 agent 且永不清理，
 * 切换/测试多个连接时 agent 对象会永久累积（内存泄漏）。
 * 空闲 socket 由 Agent 按 keepAliveMsecs(30s) 自动回收，无需手动清理。
 * maxSockets 为全 app 共享并发上限（32），同时天然限流了批量 SHOW 请求。
 */
const SHARED_AGENT = {
  http: new http.Agent({
    keepAlive: true, // 复用连接
    keepAliveMsecs: 30000,
    maxSockets: 32, // 全局并发上限
    maxFreeSockets: 4,
    timeout: 30000,
  }),
  https: new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 32,
    maxFreeSockets: 4,
    timeout: 30000,
  }),
};

function getAgent(c: RequestConn): http.Agent | https.Agent {
  return c.tls ? SHARED_AGENT.https : SHARED_AGENT.http;
}

/** 核心请求方法：底层用 Node http/https 模块，避开渲染层 CORS */
function request(
  conn: RequestConn,
  url: string,
  options: { method: 'GET' | 'POST'; authHeader?: string; body?: string; headers?: Record<string, string> },
  timeoutMs = 15000,
): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(
      url,
      {
        method: options.method,
        agent: getAgent(conn),
        headers: {
          ...(options.authHeader ? { Authorization: options.authHeader } : {}),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf-8'),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', (err) => reject(err));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('请求超时'));
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

/** 对外暴露的 InfluxDB 请求封装 */
export const influxRequest = {
  async ping(c: RequestConn): Promise<PingResult> {
    const start = Date.now();
    const url = `${buildBaseUrl(c)}/ping`;
    const { statusCode, headers } = await request(c, url, { method: 'GET' }, 8000);
    const latencyMs = Date.now() - start;
    if (statusCode !== 204) {
      throw new Error(`无法连接到 InfluxDB（HTTP ${statusCode}）`);
    }
    const version = String(headers['x-influxdb-version'] || 'unknown');
    return { version, latencyMs };
  },

  /**
   * 查询（原始响应）：不解析 JSON，直接把 statusCode + body 字符串交给调用方。
   * 大结果集时省掉主进程一次完整 JSON.parse，且 IPC 只克隆单个字符串
   * （对象树的结构化克隆远比字符串拷贝贵），解析移到渲染层做一次。
   */
  async queryRaw(
    c: RequestConn,
    q: string,
    db?: string,
    epoch?: string,
  ): Promise<{ statusCode: number; body: string }> {
    const base = buildBaseUrl(c);
    const params = new URLSearchParams();
    if (db) params.set('db', db);
    if (epoch) params.set('epoch', epoch);
    params.set('q', q);
    const url = `${base}/query?${params.toString()}`;
    const authHeader = basicAuth(c);
    const { statusCode, body } = await request(c, url, { method: 'POST', authHeader }, 20000);
    return { statusCode, body };
  },

  async write(c: RequestConn, lines: string, db: string, rp?: string): Promise<WriteResult> {
    const base = buildBaseUrl(c);
    const params = new URLSearchParams({ db });
    if (rp) params.set('rp', rp);
    const url = `${base}/write?${params.toString()}`;
    const authHeader = basicAuth(c);
    const { statusCode, body } = await request(
      c,
      url,
      {
        method: 'POST',
        authHeader,
        body: lines,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      },
      60000,
    );
    if (statusCode >= 400) {
      const err = parseErrorBody(body) || `HTTP ${statusCode}`;
      const e: Error & { statusCode?: number; influxError?: string } = new Error(err);
      e.statusCode = statusCode;
      e.influxError = err;
      throw e;
    }
    return { ok: true, statusCode };
  },
};

// ---- IPC 注册 ----

ipcMain.handle('influx:ping', async (_e, connectionId: string): Promise<PingResult> => {
  const cfg = getConfigById(connectionId);
  return influxRequest.ping(cfg);
});

ipcMain.handle('influx:query', async (_e, req: QueryRequest) => {
  const cfg = getConfigById(req.connectionId);
  const db = req.database || cfg.database;
  // 默认 epoch=ms：时间列以毫秒数字返回（比 RFC3339 字符串小 3~4 倍，
  // 渲染层 formatCell 对数字走纯数值分支，免去正则 + Date 解析）
  return influxRequest.queryRaw(cfg, req.query, db, req.epoch ?? 'ms');
});

ipcMain.handle('influx:write', async (_e, req: WriteRequest): Promise<WriteResult> => {
  const cfg = getConfigById(req.connectionId);
  return influxRequest.write(cfg, req.lines, req.database, req.retentionPolicy);
});

// ---- 主题持久化（存到 userData/theme.json）----
function themeFile(): string {
  return path.join(app.getPath('userData'), 'theme.json');
}

ipcMain.handle('theme:get', async (): Promise<'light' | 'dark' | 'system'> => {
  try {
    const raw = fs.readFileSync(themeFile(), 'utf-8');
    const v = JSON.parse(raw).value;
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
});

ipcMain.handle('theme:set', async (_e, theme: 'light' | 'dark' | 'system'): Promise<void> => {
  fs.writeFileSync(themeFile(), JSON.stringify({ value: theme }), 'utf-8');
});

// 引入 connection 模块的副作用即注册其 IPC（避免 main.ts 重复 require）
// 此处只需保证本文件被加载即可
// （connection 模块由 main.ts 直接 require，这里不需重复）
export type { ConnectionConfig };
