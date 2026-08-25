import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        // 函数形式按模块路径分包（对象形式在 pnpm 路径下匹配不到，
        // 会产生空 react chunk 且 react/react-dom 被打散进其他 chunk）。
        // Windows 下 rollup 模块 id 分隔符可能是 / 或 \，正则两者都兼容。
        //
        // 分包策略：
        // - codemirror：独立编辑器依赖，边界清晰，单独缓存；
        // - xlsx：仅导出时动态加载（含主线程回退路径），必须与首屏分离；
        // - 其余第三方全部进 vendor：react/react-dom 与 @mantine/mantine-react-table
        //   静态互相依赖，且共享 CJS 互操作辅助模块（commonjsHelpers/tslib），
        //   强行拆分会产生 mantine -> react -> mantine 循环 chunk（初始化顺序风险）。
        //   两者又总在首屏同时加载，合并无缓存损失。
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (
            /[\\/]@codemirror[\\/]|[\\/](codemirror|@lezer|@crelt|style-mod|w3c-keyname)[\\/]/.test(
              id,
            )
          ) {
            return 'codemirror';
          }
          if (/[\\/]xlsx[\\/]/.test(id)) return 'xlsx';
          return 'vendor';
        },
      },
    },
  },
});
