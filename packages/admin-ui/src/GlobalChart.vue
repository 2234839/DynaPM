<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEChart } from './composables/echarts';

use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

/** 全局折线图：所有服务请求数随时间变化（最近 24h，按 15 分钟聚合），图例可点选筛选、悬停看数值 */

/** 单个服务的统计（仅需分钟请求桶） */
interface SeriesStats {
  name: string;
  reqBuckets: [number, number][];
}

const props = defineProps<{ services: SeriesStats[] }>();

/** 当前时间：随父组件数据轮询刷新重新计算（不能用挂载时常量，页面开久了会过滤掉新数据） */
const now = ref(Date.now());
watch(
  () => props.services,
  () => {
    now.value = Date.now();
  },
  { deep: true },
);

/** 聚合粒度：15 分钟 */
const STEP_MIN = 15;
/** 24h 共 96 个桶 */
const STEPS = (24 * 60) / STEP_MIN;

/** 配色板（区分各服务折线） */
const PALETTE = [
  '#0969da', '#1f883d', '#9a6700', '#8250df', '#cf222e',
  '#1b7c83', '#bf3989', '#bc4c00',
];

/** 各服务每桶序列（与全局桶索引对齐，缺数为 0） */
const series = computed(() =>
  props.services
    .map((s, i) => {
      const buckets = new Array<number>(STEPS).fill(0);
      const stepNow = Math.floor(now.value / (STEP_MIN * 60_000));
      for (const [m, c] of s.reqBuckets) {
        const idx = STEPS - 1 - (stepNow - Math.floor(m / STEP_MIN));
        if (idx >= 0 && idx < STEPS) buckets[idx] += c;
      }
      return { name: s.name, buckets, color: PALETTE[i % PALETTE.length] };
    })
    .filter((s) => s.buckets.some((v) => v > 0)),
);

/** X 轴标签：每个桶的时间刻度文本（整点显示，其余留空） */
const xLabels = computed(() => {
  const labels: string[] = [];
  const stepNow = Math.floor(now.value / (STEP_MIN * 60_000));
  for (let i = 0; i < STEPS; i++) {
    const d = new Date((stepNow - (STEPS - 1 - i)) * STEP_MIN * 60_000);
    labels.push(d.getMinutes() === 0 ? `${String(d.getHours()).padStart(2, '0')}:00` : '');
  }
  return labels;
});

/** 全部服务合计（粗线强调） */
const totalBuckets = computed(() => {
  const t = new Array<number>(STEPS).fill(0);
  for (const s of series.value) s.buckets.forEach((v, i) => (t[i] += v));
  return t;
});

/** 24h 总请求数 */
const total24h = computed(() => totalBuckets.value.reduce((a, b) => a + b, 0));

/** echarts 配置：合计粗线 + 各服务细线，图例点选筛选 */
const option = computed(() => ({
  tooltip: {
    trigger: 'axis',
    axisPointer: { type: 'line' },
    order: 'valueDesc',
  },
  legend: {
    type: 'scroll',
    icon: 'roundRect',
    itemWidth: 14,
    itemHeight: 4,
    textStyle: { fontSize: 11, color: '#57606a' },
  },
  grid: { left: 40, right: 16, top: 32, bottom: 24 },
  xAxis: {
    type: 'category',
    boundaryGap: false,
    data: xLabels.value,
    axisLabel: { fontSize: 10, color: '#8b949e', interval: 3 },
    axisTick: { show: false },
    axisLine: { lineStyle: { color: '#d0d7de' } },
  },
  yAxis: {
    type: 'value',
    minInterval: 1,
    axisLabel: { fontSize: 10, color: '#8b949e' },
    splitLine: { lineStyle: { color: '#ebedf0' } },
  },
  series: [
    {
      name: '合计',
      type: 'line',
      showSymbol: false,
      lineStyle: { width: 2.5 },
      itemStyle: { color: '#57606a' },
      emphasis: { focus: 'series' },
      data: totalBuckets.value,
    },
    ...series.value.map((s) => ({
      name: s.name,
      type: 'line',
      showSymbol: false,
      lineStyle: { width: 1.5 },
      itemStyle: { color: s.color },
      emphasis: { focus: 'series' },
      data: s.buckets,
    })),
  ],
}));

/** 图表容器 */
const chartEl = useEChart(option);
</script>

<template>
  <div class="global-chart">
    <div class="g-head">
      <h3>请求趋势 · 最近 24 小时 <span class="g-total">{{ total24h }} 次请求</span></h3>
    </div>
    <div ref="chartEl" class="g-chart" />
    <p v-if="!series.length" class="g-empty">最近 24 小时暂无请求数据</p>
  </div>
</template>

<style scoped>
.global-chart {
  margin-top: 20px;
  background: #fff;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  padding: 12px 14px;
}
.g-head h3 {
  margin: 0 0 6px;
  font-size: 13px;
  color: #1f2328;
}
.g-total {
  font-weight: 400;
  color: #57606a;
  font-size: 12px;
}
.g-chart {
  width: 100%;
  height: 220px;
}
.g-empty {
  color: #8b949e;
  font-size: 12px;
  text-align: center;
  margin: 4px 0 0;
}
</style>
