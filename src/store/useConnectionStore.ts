import { create } from 'zustand';
import { getApi } from '@/types';
import type { ConnectionConfig } from '@/types';

interface ConnectionState {
  connections: ConnectionConfig[];
  activeId: string | null;
  loading: boolean;
  /** 加载已保存的连接列表 */
  load: () => Promise<void>;
  setActive: (id: string | null) => void;
  /** 当前激活的连接（不带密码） */
  active: () => ConnectionConfig | null;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  connections: [],
  activeId: null,
  loading: false,

  load: async () => {
    set({ loading: true });
    try {
      const list = await getApi().listConnections();
      set({ connections: list });
    } finally {
      set({ loading: false });
    }
  },

  setActive: (id) => set({ activeId: id }),

  active: () => {
    const { connections, activeId } = get();
    return connections.find((c) => c.id === activeId) || null;
  },
}));
