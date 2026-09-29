/// <reference types="vite/client" />

/** 自定义环境变量类型 */
interface ImportMetaEnv {
  /** admin API baseURL，默认空（同源，dev 走 vite 代理） */
  readonly VITE_ADMIN_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
