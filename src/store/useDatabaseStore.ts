import { create } from 'zustand';
import { getApi } from '@/types';

interface DatabaseState {
  /** 按 connectionId 缓存的数据库列表 */
  byConnection: Record<string, string[]>;
  /** 当前正在加载的 connectionId（避免并发重复请求） */
  loadingId: string | null;

  /** 获取某连接的数据库列表，命中缓存直接返回，否则拉取一次 */
  load: (connectionId: string, force?: boolean) => Promise<string[]>;
  /** 同步读取（可能为空，用于 Select 渲染） */
  get: (connectionId: string) => string[];
}

export const useDatabaseStore = create<DatabaseState>((set, get) => ({
  byConnection: {},
  loadingId: null,

  load: async (connectionId, force) => {
    // 已缓存且非强制刷新：直接返回
    if (!force && get().byConnection[connectionId]) {
      return get().byConnection[connectionId];
    }
    // 已有进行中的同连接请求：等待它（简化处理：直接发起，结果覆盖，开销可接受）
    set({ loadingId: connectionId });
    try {
      const res = await getApi().query({ connectionId, query: 'SHOW DATABASES' });
      const series = res.results?.[0]?.series?.[0];
      const dbs = (series?.values || []).map((v) => String(v[0])).filter((d) => d !== '_internal');
      set((s) => ({ byConnection: { ...s.byConnection, [connectionId]: dbs } }));
      return dbs;
    } catch {
      return get().byConnection[connectionId] || [];
    } finally {
      if (get().loadingId === connectionId) set({ loadingId: null });
    }
  },

  get: (connectionId) => get().byConnection[connectionId] || [],
}));
