import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  /** 面板可能挂在 /_dynapm/panel/ 或专属管理域名根路径 /，用相对 base 两者兼容 */
  base: './',
  server: {
    port: 5173,
    proxy: {
      /** dev 环境 admin API 代理到本地 gateway admin 端口 */
      '/_dynapm': {
        target: 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
