/**
 * 分页组合式函数：页大小选项持久化、页码夹紧、筛选变化自动回第一页。
 * App.vue 服务表与 ConfigEditor 服务卡片共用，禁止在组件内重写分页状态
 */
import { computed, ref, watch, type Ref } from 'vue';
import { persistedRef } from '../persistedRef';

/** 常用每页条数选项（万级数据全量渲染会拖死主线程，分页控制单次 DOM 规模） */
export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 200];

/**
 * @param source 已排序/过滤后的全量切片函数（通常传 computed 的 .value 读取）
 * @param persistKey pageSize 持久化键（各调用方独立记忆页大小）
 * @param defaultSize 默认每页条数
 * @param resets 额外触发回第一页的响应式依赖（如筛选关键字）
 */
export function usePagination<T>(
  source: () => readonly T[],
  persistKey: string,
  defaultSize: number,
  resets: Ref<unknown>[] = [],
) {
  /** 每页条数（用户选择本地持久化） */
  const pageSize = persistedRef(persistKey, defaultSize);
  /** 当前页（1 起） */
  const pageNo = ref(1);
  const totalPages = computed(() => Math.max(Math.ceil(source().length / pageSize.value), 1));
  /** 当前页实际渲染的切片 */
  const renderedSlice = computed(() => {
    const list = source();
    return list.slice((pageNo.value - 1) * pageSize.value, pageNo.value * pageSize.value);
  });
  watch([source, pageSize, ...resets], () => {
    pageNo.value = 1;
  });
  /** 翻页：n 越界自动夹紧 */
  function gotoPage(n: number): void {
    pageNo.value = Math.min(Math.max(n, 1), totalPages.value);
  }
  return { pageSize, pageNo, totalPages, renderedSlice, gotoPage, PAGE_SIZE_OPTIONS };
}
