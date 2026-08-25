import { create } from 'zustand';
import type { SavedQuery } from '@/types';
import { getApi } from '@/types';

/** 查询历史记录 */
export interface QueryHistoryItem {
  id: string;
  sql: string;
  database?: string;
  at: number;
  ok: boolean;
  durationMs?: number;
}

export interface QueryTab {
  id: string;
  title: string;
  sql: string;
  database?: string;
  /** 查询编辑器（上方编辑区）高度（px）；可拖拽调整，缺省 200 */
  editorHeight?: number;
}

interface WorkspaceState {
  tabs: QueryTab[];
  activeTabId: string | null;
  history: QueryHistoryItem[];
  /** 查询历史抽屉是否可见（独立 state，避免放在 QueryEditor 内导致重渲染卡顿） */
  historyVisible: boolean;
  /** 收藏查询（当前连接下的，连接切换时由 loadSavedQueries 刷新） */
  savedQueries: SavedQuery[];
  /** 收藏查询抽屉是否可见 */
  savedVisible: boolean;

  newQuery: (database?: string) => void;
  /** 连接就绪时确保至少有一个查询 tab。已存在则不重复创建（幂等）。 */
  ensureQueryTab: (database?: string) => void;
  openQuery: (sql: string, database?: string) => void;
  openAdmin: () => void;
  openWrite: () => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  updateTab: (id: string, patch: Partial<Omit<QueryTab, 'id'>>) => void;
  addHistory: (item: QueryHistoryItem) => void;
  clearHistory: () => void;
  setHistoryVisible: (v: boolean) => void;
  /** 拉取某连接下的收藏查询到 store */
  loadSavedQueries: (connectionId: string) => void;
  /** 新增收藏查询（写盘 + 刷新列表） */
  addSavedQuery: (item: SavedQuery) => Promise<void>;
  /** 删除收藏查询 */
  removeSavedQuery: (id: string) => void;
  setSavedVisible: (v: boolean) => void;
}

let seq = 0;
function genId(): string {
  seq += 1;
  return `tab_${Date.now()}_${seq}`;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  history: [],
  historyVisible: false,
  savedQueries: [],
  savedVisible: false,

  newQuery: (database) => {
    const id = genId();
    const tab: QueryTab = { id, title: `查询 ${get().tabs.length + 1}`, sql: '', database };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
  },

  // 连接就绪时确保至少有一个查询 tab。用 getState() 读最新值做幂等判断，
  // 严格模式下 effect 双调用、或并发调用都只会创建一个，避免出现两个初始 tab。
  ensureQueryTab: (database) => {
    if (get().tabs.length > 0) {
      // 已有 tab：若当前无激活项，激活第一个
      if (!get().activeTabId) {
        set({ activeTabId: get().tabs[0].id });
      }
      return;
    }
    const id = genId();
    const tab: QueryTab = { id, title: '查询 1', sql: '', database };
    set({ tabs: [tab], activeTabId: id });
  },

  openQuery: (sql, database) => {
    const id = genId();
    const tab: QueryTab = {
      id,
      title: sql.length > 16 ? sql.slice(0, 16) + '…' : sql || `查询 ${get().tabs.length + 1}`,
      sql,
      database,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
  },

  openAdmin: () => {
    const id = genId();
    set((s) => ({ tabs: [...s.tabs, { id, title: '__admin__管理', sql: '' }], activeTabId: id }));
  },

  openWrite: () => {
    const id = genId();
    set((s) => ({ tabs: [...s.tabs, { id, title: '__write__数据写入', sql: '' }], activeTabId: id }));
  },

  closeTab: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeTabId = s.activeTabId;
      if (activeTabId === id) {
        // 切到相邻 tab：优先右侧，没有则左侧，再没有则置空。
        // 注意必须在 filter 后的新数组上按下标取，旧 idx 已失效。
        activeTabId = tabs[idx]?.id || tabs[idx - 1]?.id || null;
      }
      return { tabs, activeTabId };
    }),

  setActive: (id) => set({ activeTabId: id }),

  updateTab: (id, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),

  addHistory: (item) => set((s) => ({ history: [item, ...s.history].slice(0, 100) })),

  clearHistory: () => set({ history: [] }),

  setHistoryVisible: (v) => set({ historyVisible: v }),

  // 收藏查询：连接切换时拉取该连接下的收藏列表（主进程已按 createdAt 倒序返回）
  loadSavedQueries: (connectionId) => {
    void getApi()
      .listSavedQueries(connectionId)
      .then((list) => set({ savedQueries: list }))
      .catch(() => set({ savedQueries: [] }));
  },
  // 新增收藏：写盘后刷新列表（确保 store 与磁盘一致）
  addSavedQuery: async (item) => {
    await getApi().saveSavedQuery(item);
    await getApi()
      .listSavedQueries(item.connectionId)
      .then((list) => set({ savedQueries: list }));
  },
  // 删除收藏：写盘后从 store 移除该项
  removeSavedQuery: (id) => {
    void getApi().deleteSavedQuery(id);
    set((s) => ({ savedQueries: s.savedQueries.filter((q) => q.id !== id) }));
  },
  setSavedVisible: (v) => set({ savedVisible: v }),
}));
