import { app, ipcMain, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { ConnectionConfig, ConnectionForm, PingResult } from '../types';
import { influxRequest } from './influx';

/** 磁盘上持久化的连接结构（密码以加密字符串保存） */
interface StoredConnection extends Omit<ConnectionConfig, 'password'> {
  /** safeStorage 加密后的 base64 密文，明文密码不存在磁盘 */
  encryptedPassword?: string;
}

function connectionsFile(): string {
  return path.join(app.getPath('userData'), 'connections.json');
}

function readAll(): StoredConnection[] {
  const file = connectionsFile();
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? (data as StoredConnection[]) : [];
  } catch {
    return [];
  }
}

function writeAll(list: StoredConnection[]): void {
  const file = connectionsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf-8');
  // 配置有变化，清空解密缓存，下次按需重建
  configCache.clear();
}

/**
 * 解密后的连接配置内存缓存：避免每次查询都读 connections.json + 跑 safeStorage 解密。
 * safeStorage 解密涉及系统密钥调用，单次约几 ms，叠加多次 SHOW 查询会有可感延迟。
 */
const configCache = new Map<string, ConnectionConfig>();

/** 加密明文密码；若平台不支持 safeStorage 则回退到 base64（仅作占位） */
function encryptPassword(plain?: string): string | undefined {
  if (!plain) return undefined;
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plain).toString('base64');
  }
  return Buffer.from(plain, 'utf-8').toString('base64');
}

function decryptPassword(encrypted?: string): string | undefined {
  if (!encrypted) return undefined;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    }
    return Buffer.from(encrypted, 'base64').toString('utf-8');
  } catch {
    return undefined;
  }
}

/** 把存储结构转换为对外暴露的连接配置（解密密码，仅用于发请求时） */
export function toConfig(stored: StoredConnection): ConnectionConfig {
  const { encryptedPassword, ...rest } = stored;
  return {
    ...rest,
    password: decryptPassword(encryptedPassword),
  };
}

/** 根据 id 查询单条连接（含解密后的密码），找不到抛错。命中缓存则零开销返回。 */
export function getConfigById(id: string): ConnectionConfig {
  const cached = configCache.get(id);
  if (cached) return cached;
  const stored = readAll().find((c) => c.id === id);
  if (!stored) throw new Error(`未找到连接: ${id}`);
  const cfg = toConfig(stored);
  configCache.set(id, cfg);
  return cfg;
}

// ---- IPC 注册 ----

// 读取所有连接（注意：返回时不携带明文密码，password 字段留空）
ipcMain.handle('connection:list', (): ConnectionConfig[] => {
  return readAll().map((s) => {
    const { encryptedPassword, ...rest } = s;
    void encryptedPassword;
    return { ...rest, password: undefined };
  });
});

ipcMain.handle(
  'connection:save',
  async (_e, payload: ConnectionForm & { id?: string }): Promise<ConnectionConfig> => {
    const list = readAll();
    const now = Date.now();
    if (payload.id) {
      const idx = list.findIndex((c) => c.id === payload.id);
      if (idx === -1) throw new Error('连接不存在');
      const prev = list[idx];
      // 若表单 password 为空，则保留原密码
      const newPassword = payload.password ? payload.password : decryptPassword(prev.encryptedPassword);
      const updated: StoredConnection = {
        ...prev,
        name: payload.name,
        host: payload.host,
        port: payload.port,
        username: payload.username,
        database: payload.database,
        tls: payload.tls,
        encryptedPassword: encryptPassword(newPassword),
        updatedAt: now,
      };
      list[idx] = updated;
      writeAll(list);
      return { ...toConfig(updated), password: undefined };
    }

    const created: StoredConnection = {
      id: randomUUID(),
      name: payload.name,
      host: payload.host,
      port: payload.port,
      username: payload.username,
      database: payload.database,
      tls: payload.tls,
      encryptedPassword: encryptPassword(payload.password),
      createdAt: now,
      updatedAt: now,
    };
    list.push(created);
    writeAll(list);
    return { ...toConfig(created), password: undefined };
  },
);

ipcMain.handle('connection:delete', (_e, id: string): void => {
  const list = readAll().filter((c) => c.id !== id);
  writeAll(list);
});

// 测试连接：用表单（明文）直接发 ping，无需先保存
ipcMain.handle(
  'connection:test',
  async (_e, form: ConnectionForm): Promise<PingResult> => {
    return influxRequest.ping({
      host: form.host,
      port: form.port,
      username: form.username,
      password: form.password,
      tls: form.tls,
    });
  },
);

// ---- 收藏查询持久化（存到 userData/saved-queries.json，按连接隔离）----
import type { SavedQuery } from '../types';

function savedQueriesFile(): string {
  return path.join(app.getPath('userData'), 'saved-queries.json');
}

function readSavedQueries(): SavedQuery[] {
  const file = savedQueriesFile();
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? (data as SavedQuery[]) : [];
  } catch {
    return [];
  }
}

function writeSavedQueries(list: SavedQuery[]): void {
  const file = savedQueriesFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf-8');
}

/** 读取某连接下的全部收藏查询 */
ipcMain.handle('saved:list', (_e, connectionId: string): SavedQuery[] => {
  return readSavedQueries()
    .filter((q) => q.connectionId === connectionId)
    .sort((a, b) => b.createdAt - a.createdAt); // 最新的在前
});

/** 新增或更新收藏查询（按 id upsert） */
ipcMain.handle('saved:upsert', (_e, item: SavedQuery): void => {
  const list = readSavedQueries();
  const idx = list.findIndex((q) => q.id === item.id);
  if (idx >= 0) list[idx] = item;
  else list.push(item);
  writeSavedQueries(list);
});

/** 删除收藏查询 */
ipcMain.handle('saved:delete', (_e, id: string): void => {
  writeSavedQueries(readSavedQueries().filter((q) => q.id !== id));
});
