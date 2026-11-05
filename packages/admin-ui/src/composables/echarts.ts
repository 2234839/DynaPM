import { onBeforeUnmount, onMounted, ref, watch, type Ref, type ShallowRef } from 'vue';
import { init, type EChartsType, type EChartsCoreOption } from 'echarts/core';

/**
 * ECharts 通用组合函数：负责实例生命周期（挂载初始化 / 卸载销毁 / 容器尺寸自适应）
 * @param option 响应式图表配置（变更时自动 setOption）
 * @returns 图表容器 DOM ref（绑定到 template）
 */
export function useEChart(option: Ref<EChartsCoreOption>): ShallowRef<HTMLElement | null> {
  /** 图表容器 DOM */
  const el = ref<HTMLElement | null>(null);
  /** echarts 实例 */
  let chart: EChartsType | null = null;

  onMounted(() => {
    if (!el.value) return;
    chart = init(el.value);
    chart.setOption(option.value);
    const ro = new ResizeObserver(() => chart?.resize());
    ro.observe(el.value);
    onBeforeUnmount(() => {
      ro.disconnect();
      chart?.dispose();
      chart = null;
    });
  });

  watch(option, (opt) => chart?.setOption(opt, { notMerge: true }));

  return el;
}
