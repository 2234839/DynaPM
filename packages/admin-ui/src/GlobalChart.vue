<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { HeatmapChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, VisualMapComponent } from 'echarts/components';
import { use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEChart } from './composables/echarts';

use([HeatmapChart, GridComponent, TooltipComponent, VisualMapComponent, CanvasRenderer]);

/**
 * 全局热力图：每个服务一行 × 15 分钟一列，颜色深浅编码该时段请求数。
 * 适合本数据形态：多服务 × 时间桶的稀疏计数矩阵——行间互不挤压，
 * 低流量服务不会被高流量服务淹没，无请求的格子天然空白，也不存在堆叠/连线编造过渡的问题
 */

/** 单个服务的统计（仅需分钟请求桶），remote 时带面板名前缀 */
interface SeriesStats {
  name: string;
  reqBuckets: [number, number][];
  /** 所属面板显示名（本地行为空串） */
  panelName?: string;
}

const props = defineProps<{ services: SeriesStats[] }>();

/** 服务名/面板名搜索关键字（不区分大小写，空 = 不过滤） */
const searchKw = ref('');
/** 面板筛选：空 = 全部；'local' = 仅本地；否则为面板名 */
const filterPanel = ref('');

/** 面板名列表（去重，供筛选下拉） */
const panelNames = computed(() =>
  [...new Set(props.services.map((s) => s.panelName || '').filter(Boolean))].sort(),
);

/** 搜索 + 面板筛选后的服务序列 */
const visibleServices = computed(() => {
  const kw = searchKw.value.trim().toLowerCase();
  return props.services.filter((s) => {
    const panel = s.panelName || '';
    if (filterPanel.value === 'local' && panel) return false;
    if (filterPanel.value && filterPanel.value !== 'local' && panel !== filterPanel.value) return false;
    if (kw && !s.name.toLowerCase().includes(kw) && !panel.toLowerCase().includes(kw)) return false;
    return true;
  });
});

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

/** 有流量的服务列表（按 24h 总量降序，流量大的行放上面）及其每桶计数 */
const rows = computed(() =>
  visibleServices.value
    .map((s) => {
      const buckets = new Array<number>(STEPS).fill(0);
      const stepNow = Math.floor(now.value / (STEP_MIN * 60_000));
      for (const [m, c] of s.reqBuckets) {
        const idx = STEPS - 1 - (stepNow - Math.floor(m / STEP_MIN));
        if (idx >= 0 && idx < STEPS) buckets[idx] += c;
      }
      return { name: s.name, buckets };
    })
    .filter((s) => s.buckets.some((v) => v > 0))
    .sort((a, b) => b.buckets.reduce((x, y) => x + y, 0) - a.buckets.reduce((x, y) => x + y, 0)),
);

/** 桶起始时间文本（tooltip 用）：由桶索引反推 HH:MM */
const bucketTime = (x: number) => {
  const stepNow = Math.floor(now.value / (STEP_MIN * 60_000));
  const d = new Date((stepNow - (STEPS - 1 - x)) * STEP_MIN * 60_000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** X 轴标签：整点显示时刻，其余留空 */
const xLabels = computed(() => {
  const labels: string[] = [];
  for (let i = 0; i < STEPS; i++) {
    const t = bucketTime(i);
    labels.push(t.endsWith(':00') ? t : '');
  }
  return labels;
});

/** 24h 总请求数 */
const total24h = computed(() => rows.value.reduce((acc, r) => acc + r.buckets.reduce((a, b) => a + b, 0), 0));

/** 单格最大计数（色阶上限） */
const maxCell = computed(() => rows.value.reduce((acc, r) => Math.max(acc, ...r.buckets), 0));

/** 热力图数据：[列索引, 行索引, log 变换后的计数]，0 桶不给数据（保持空白）。log 变换拉开低值区分度，否则 1~10 次的格子全被挤在最浅一档分不清 */
const heatData = computed(() => {
  const data: [number, number, number][] = [];
  rows.value.forEach((r, y) => {
    r.buckets.forEach((v, x) => {
      if (v > 0) data.push([x, y, Math.log10(v) + 1]);
    });
  });
  return data;
});

/** 每行 24h 小计（图下列表用） */
const rowTotals = computed(() => rows.value.map((r) => r.buckets.reduce((a, b) => a + b, 0)));

const option = computed(() => ({
  tooltip: {
    /** 悬停格子：时间 + 服务 + 该 15 分钟请求数（显示原始值，log 只用于染色） */
    formatter: (p: { data: [number, number, number] }) => {
      const [x, y, lv] = p.data;
      const v = Math.round(10 ** (lv - 1));
      return `<b>${rows.value[y]?.name ?? ''}</b><br/>${bucketTime(x)} 起的 15 分钟<br/>${v} 次请求`;
    },
  },
  grid: { left: 96, right: 56, top: 8, bottom: 24 },
  xAxis: {
    type: 'category',
    data: xLabels.value,
    axisLabel: { fontSize: 10, color: '#8b949e', interval: 7 },
    axisTick: { show: false },
    axisLine: { show: false },
    splitArea: { show: false },
  },
  yAxis: {
    type: 'category',
    data: rows.value.map((r) => r.name),
    axisLabel: { fontSize: 11, color: '#57606a' },
    axisTick: { show: false },
    axisLine: { show: false },
  },
  visualMap: {
    /** 连续色阶染 log 值：淡蓝→深蓝；刻度标签回显真实请求数（1/10/100...） */
    type: 'continuous',
    min: 0,
    max: Math.max(Math.log10(Math.max(maxCell.value, 1)) + 1, 1),
    calculable: false,
    orient: 'vertical',
    right: 0,
    top: 'center',
    itemHeight: 80,
    itemWidth: 12,
    textStyle: { fontSize: 9, color: '#8b949e' },
    formatter: (lv: number) => (lv <= 0 ? '0' : String(Math.round(10 ** (lv - 1)))),
    inRange: { color: ['#e8f2fc', '#9ecdf5', '#4a9be0', '#1668b8', '#0a3d75'] },
  },
  series: [
    {
      type: 'heatmap',
      data: heatData.value,
      /** 格子间留 1px 白缝，颜色不糊成一片 */
      itemStyle: { borderColor: '#fff', borderWidth: 1 },
      emphasis: { itemStyle: { borderColor: '#1f2328', borderWidth: 1 } },
    },
  ],
}));

/** 图表容器（高度随服务行数自适应） */
const chartEl = useEChart(option);
</script>

<template>
  <div class="global-chart">
    <div class="g-head">
      <h3>
        请求分布 · 最近 24 小时 <span class="g-total">{{ total24h }} 次请求</span>
      </h3>
      <div class="g-filters">
        <input
          v-model="searchKw"
          class="g-search"
          type="search"
          placeholder="搜索服务/面板…"
        />
        <select v-model="filterPanel" class="g-panel-select" title="按面板筛选">
          <option value="">全部（{{ props.services.length }}）</option>
          <option value="local">本地（{{ props.services.filter((s) => !s.panelName).length }}）</option>
          <option v-for="p in panelNames" :key="p" :value="p">
            {{ p }}（{{ props.services.filter((s) => s.panelName === p).length }}）
          </option>
        </select>
      </div>
    </div>
    <div ref="chartEl" class="g-chart" :style="{ height: `${Math.max(rows.length, 1) * 26 + 40}px` }" />
    <div v-if="rows.length" class="g-rows">
      <span v-for="(r, i) in rows" :key="r.name" class="g-row-item">
        {{ r.name }} <b>{{ rowTotals[i] }}</b>
      </span>
    </div>
    <p v-if="!rows.length" class="g-empty">最近 24 小时暂无请求数据</p>
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
.g-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.g-head h3 {
  margin: 0 0 6px;
  font-size: 13px;
  color: #1f2328;
}
.g-filters {
  display: flex;
  align-items: center;
  gap: 6px;
}
.g-search {
  width: 160px;
  padding: 3px 8px;
  font-size: 12px;
  border: 1px solid #d0d7de;
  border-radius: 6px;
}
.g-search:focus {
  outline: 2px solid #0969da33;
  border-color: #0969da;
}
.g-panel-select {
  padding: 3px 6px;
  font-size: 12px;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  background: #fff;
}
.g-total {
  font-weight: 400;
  color: #57606a;
  font-size: 12px;
}
.g-chart {
  width: 100%;
  min-height: 60px;
}
.g-rows {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin-top: 4px;
  font-size: 11px;
  color: #57606a;
}
.g-row-item b {
  color: #1f2328;
}
.g-empty {
  color: #8b949e;
  font-size: 12px;
  text-align: center;
  margin: 4px 0 0;
}
</style>
