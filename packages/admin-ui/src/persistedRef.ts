/**
 * localStorage 持久化的 ref：读写同一个 key 的组件（跨刷新）共享用户上次的选择
 * 值以 JSON 序列化存储；解析失败时回退默认值（用户手动改脏 localStorage 不至于白屏）
 */
import { ref, watch, type Ref } from 'vue';

/** key 前缀，避免与其他应用在同源下的存储冲突 */
const PREFIX = 'dynapm.';

/** 创建一个值变更自动写入 localStorage 的 ref（初始值优先取上次持久化的值） */
export function persistedRef<T>(key: string, initial: T): Ref<T> {
  const storageKey = PREFIX + key;
  let restored = initial;
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw !== null) restored = JSON.parse(raw) as T;
  } catch {
    // 数据损坏时静默回退默认值
  }
  const r = ref(restored) as Ref<T>;
  watch(r, (v) => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(v ?? null));
    } catch {
      // 存储满/隐私模式写失败不影响功能
    }
  }, { deep: true });
  return r;
}
