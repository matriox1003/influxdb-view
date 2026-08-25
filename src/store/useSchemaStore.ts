import { create } from 'zustand';
import { getApi } from '@/types';

/**
 * 测量值(measurement)、字段(field)、标签(tag)的缓存，供编辑器补全使用。
 * 按 connectionId + database 二级索引，避免重复 SHOW 查询。
 * Sidebar 展开数据库时也会填充这里，与树共享同一份数据。
 */
interface SchemaState {
  /** key = `${connectionId}:${database}` → measurement 名列表 */
  measurements: Record<string, string[]>;
  /** key = `${connectionId}:${database}:${measurement}` → field 名列表 */
  fields: Record<string, string[]>;
  /** key = `${connectionId}:${database}:${measurement}` → tag 名列表 */
  tags: Record<string, string[]>;
  /** 正在加载的 key 集合，防并发重复请求 */
  loading: Set<string>;
  /** schema 数据版本号：任何 measurements/fields/tags 写入都自增，供补全候选缓存失效判断 */
  schemaVersion: number;

  /** 加载某库的 measurement 列表（命中缓存直接返回） */
  loadMeasurements: (connectionId: string, database: string, force?: boolean) => Promise<string[]>;
  /** 加载某 measurement 的 field 列表（命中缓存直接返回） */
  loadFields: (connectionId: string, database: string, measurement: string, force?: boolean) => Promise<string[]>;
  /** 加载某 measurement 的 tag 列表（命中缓存直接返回） */
  loadTags: (connectionId: string, database: string, measurement: string, force?: boolean) => Promise<string[]>;
  /** 选择库时一次性预加载：2 条批量查询拉全库字段/标签（旧版本 InfluxDB 不支持时回退逐个加载） */
  preloadDatabase: (connectionId: string, database: string, force?: boolean) => Promise<void>;
  /** 同步读取 measurement 列表（可能为空） */
  getMeasurements: (connectionId: string, database: string) => string[];
  /** 同步读取某 measurement 的 field 列表（可能为空） */
  getFields: (connectionId: string, database: string, measurement: string) => string[];
  /** 同步读取某 measurement 的 tag 列表（可能为空） */
  getTags: (connectionId: string, database: string, measurement: string) => string[];
  /** 该 measurement 的 tag 列表是否已加载过（区分「未加载」与「确实无标签」） */
  hasTags: (connectionId: string, database: string, measurement: string) => boolean;
}

const mk = (connId: string, db: string) => `${connId}:${db}`;
const mkF = (connId: string, db: string, m: string) => `${connId}:${db}:${m}`;
const mkT = (connId: string, db: string, m: string) => `${connId}:${db}:${m}`;

export const useSchemaStore = create<SchemaState>((set, get) => ({
  measurements: {},
  fields: {},
  tags: {},
  loading: new Set(),
  schemaVersion: 0,

  loadMeasurements: async (connectionId, database, force) => {
    const key = mk(connectionId, database);
    if (!force && get().measurements[key]) return get().measurements[key];
    if (get().loading.has(key)) {
      // 已有进行中请求：轮询等待结果（简化处理）
      await new Promise((r) => setTimeout(r, 200));
      return get().measurements[key] || [];
    }
    set((s) => ({ loading: new Set(s.loading).add(key) }));
    try {
      const res = await getApi().query({ connectionId, database, query: 'SHOW MEASUREMENTS' });
      const series = res.results?.[0]?.series?.[0];
      const col = series?.columns?.[0];
      const ms = col ? (series?.values || []).map((v) => String(v[0])).filter(Boolean) : [];
      set((s) => ({
        measurements: { ...s.measurements, [key]: ms },
        schemaVersion: s.schemaVersion + 1,
      }));
      return ms;
    } catch (err) {
      console.error('[schema] loadMeasurements failed', { connectionId, database }, err);
      return get().measurements[key] || [];
    } finally {
      set((s) => {
        const next = new Set(s.loading);
        next.delete(key);
        return { loading: next };
      });
    }
  },

  loadFields: async (connectionId, database, measurement, force) => {
    const key = mkF(connectionId, database, measurement);
    if (!force && get().fields[key]) return get().fields[key];
    if (get().loading.has(key)) {
      await new Promise((r) => setTimeout(r, 200));
      return get().fields[key] || [];
    }
    set((s) => ({ loading: new Set(s.loading).add(key) }));
    try {
      const res = await getApi().query({
        connectionId,
        database,
        query: `SHOW FIELD KEYS FROM "${measurement}"`,
      });
      // SHOW FIELD KEYS 返回结构：results[0].series 可能是多个（按 measurement 分组），
      // 每个 series 的 columns 含 fieldKey，values 是字段名列表。取所有 series 合并。
      const seriesList = res.results?.[0]?.series || [];
      const allFields: string[] = [];
      for (const ser of seriesList) {
        const idx = ser.columns.indexOf('fieldKey');
        const i = idx >= 0 ? idx : 0;
        for (const v of ser.values || []) {
          if (v[i] != null && v[i] !== '') allFields.push(String(v[i]));
        }
      }
      set((s) => ({
        fields: { ...s.fields, [key]: allFields },
        schemaVersion: s.schemaVersion + 1,
      }));
      return allFields;
    } catch (err) {
      console.error('[schema] loadFields failed', { connectionId, database, measurement }, err);
      return get().fields[key] || [];
    } finally {
      set((s) => {
        const next = new Set(s.loading);
        next.delete(key);
        return { loading: next };
      });
    }
  },

  loadTags: async (connectionId, database, measurement, force) => {
    const key = mkT(connectionId, database, measurement);
    if (!force && get().tags[key]) return get().tags[key];
    if (get().loading.has(key)) {
      await new Promise((r) => setTimeout(r, 200));
      return get().tags[key] || [];
    }
    set((s) => ({ loading: new Set(s.loading).add(key) }));
    try {
      const res = await getApi().query({
        connectionId,
        database,
        query: `SHOW TAG KEYS FROM "${measurement}"`,
      });
      // SHOW TAG KEYS 返回结构同 SHOW FIELD KEYS：results[0].series，columns 含 tagKey
      const seriesList = res.results?.[0]?.series || [];
      const allTags: string[] = [];
      for (const ser of seriesList) {
        const idx = ser.columns.indexOf('tagKey');
        const i = idx >= 0 ? idx : 0;
        for (const v of ser.values || []) {
          if (v[i] != null && v[i] !== '') allTags.push(String(v[i]));
        }
      }
      set((s) => ({
        tags: { ...s.tags, [key]: allTags },
        schemaVersion: s.schemaVersion + 1,
      }));
      return allTags;
    } catch (err) {
      console.error('[schema] loadTags failed', { connectionId, database, measurement }, err);
      return get().tags[key] || [];
    } finally {
      set((s) => {
        const next = new Set(s.loading);
        next.delete(key);
        return { loading: next };
      });
    }
  },

  preloadDatabase: async (connectionId, database, force) => {
    // 1. 先确保 measurement 列表已加载
    const ms = await get().loadMeasurements(connectionId, database, force);
    if (ms.length === 0) return;

    // 2. 非 force 时全量命中缓存则零请求
    if (!force) {
      const { fields, tags } = get();
      const allCached = ms.every(
        (m) => fields[mkF(connectionId, database, m)] && tags[mkT(connectionId, database, m)],
      );
      if (allCached) return;
    }

    // 3. 批量预加载：不带 FROM 的 SHOW FIELD KEYS / SHOW TAG KEYS 一次返回全库，
    //    每条 series 带 name=measurement。2 条请求替代旧的 2N 条（N=measurement 数），
    //    大库（上千 measurement）预加载从秒级往返降到 2 次往返。
    try {
      const [fieldsRes, tagsRes] = await Promise.all([
        getApi().query({ connectionId, database, query: 'SHOW FIELD KEYS' }),
        getApi().query({ connectionId, database, query: 'SHOW TAG KEYS' }),
      ]);
      const nextFields: Record<string, string[]> = {};
      for (const ser of fieldsRes.results?.[0]?.series || []) {
        if (!ser.name) continue;
        const idx = ser.columns.indexOf('fieldKey');
        const i = idx >= 0 ? idx : 0;
        nextFields[mkF(connectionId, database, ser.name)] = (ser.values || [])
          .map((v) => String(v[i]))
          .filter(Boolean);
      }
      const nextTags: Record<string, string[]> = {};
      for (const ser of tagsRes.results?.[0]?.series || []) {
        if (!ser.name) continue;
        const idx = ser.columns.indexOf('tagKey');
        const i = idx >= 0 ? idx : 0;
        nextTags[mkT(connectionId, database, ser.name)] = (ser.values || [])
          .map((v) => String(v[i]))
          .filter(Boolean);
      }
      set((s) => ({
        fields: { ...s.fields, ...nextFields },
        tags: { ...s.tags, ...nextTags },
        schemaVersion: s.schemaVersion + 1,
      }));
      return;
    } catch {
      // 旧版本 InfluxDB 不支持无 FROM 的 SHOW FIELD/TAG KEYS：回退逐个加载
    }

    // 4. 回退路径：按 measurement 成对加载（loadFields/loadTags 自带缓存，已加载的会跳过）。
    //    限流并发（同时最多 PRELOAD_CONCURRENCY 组）：大库全量并发会瞬间涌出上千个 SHOW 请求。
    const PRELOAD_CONCURRENCY = 8;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(PRELOAD_CONCURRENCY, ms.length) }, async () => {
      while (cursor < ms.length) {
        const m = ms[cursor];
        cursor += 1;
        await Promise.all([
          get().loadFields(connectionId, database, m, force),
          get().loadTags(connectionId, database, m, force),
        ]);
      }
    });
    await Promise.all(workers);
  },

  getMeasurements: (connectionId, database) => get().measurements[mk(connectionId, database)] || [],
  getFields: (connectionId, database, measurement) =>
    get().fields[mkF(connectionId, database, measurement)] || [],
  getTags: (connectionId, database, measurement) =>
    get().tags[mkT(connectionId, database, measurement)] || [],
  hasTags: (connectionId, database, measurement) =>
    Boolean(get().tags[mkT(connectionId, database, measurement)]),
}));
