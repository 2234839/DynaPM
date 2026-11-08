<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { HeatmapChart, CustomChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, VisualMapComponent } from 'echarts/components';
import { use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEChart } from './composables/echarts';
import { persistedRef } from './persistedRef';

use([HeatmapChart, CustomChart, GridComponent, TooltipComponent, VisualMapComponent, CanvasRenderer]);

/**
 * 全局热力图：每个服务一行 × 15 分钟一列，颜色深浅编码该时段请求数。
 * 适合本数据形态：多服务 × 时间桶的稀疏计数矩阵——行间互不挤压，
 * 低流量服务不会被高流量服务淹没，无请求的格子天然空白，也不存在堆叠/连线编造过渡的问题
 */

/** 单个服务的统计（仅需分钟请求桶），remote 时带面板名前缀 */
interface SeriesStats {
  name: string;
  reqBuckets: [number, number][];
  /** 存活区间 [startMs, endMs]，end=-1 表示进行中 */
  aliveSpans?: [number, number][];
  /** 所属面板显示名（本地行为空串） */
  panelName?: string;
}

const props = defineProps<{ services: SeriesStats[] }>();

/** 服务名/面板名搜索关键字（不区分大小写，空 = 不过滤） */
const searchKw = ref('');
/** 面板筛选：空 = 全部；'local' = 仅本地；否则为面板名（用户选择本地持久化） */
const filterPanel = persistedRef('chart.filterPanel', '');

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

/** 有流量的服务列表（按 24h 总量降序，流量大的行放上面）及其每桶计数。
 *  万级服务下 canvas 数据项数 = 行数 × 96，不限制会把图表渲染拖到数十秒；
 *  只画流量 Top-K，搜索/筛选命中后仍可定位任意服务 */
/** 可选展示行数与默认值：行数 × 96 个 canvas 数据项，过大拖慢渲染（用户选择本地持久化） */
const ROW_OPTIONS = [10, 20, 50, 100, 200];
const maxRows = persistedRef('chart.maxRows', 50);
/** 未进上限的低流量服务数（截断提示用） */
const truncatedCount = computed(() => rows.value.length - topRows.value.length);
const rows = computed(() =>
  visibleServices.value
    .map((s) => {
      const buckets = new Array<number>(STEPS).fill(0);
      const stepNow = Math.floor(now.value / (STEP_MIN * 60_000));
      // 后端扁平编码 [minute, count, …]，分钟已按 step 对齐
      for (let i = 0; i + 1 < s.reqBuckets.length; i += 2) {
        const m = s.reqBuckets[i]!;
        const c = s.reqBuckets[i + 1]!;
        const idx = STEPS - 1 - (stepNow - Math.floor(m / STEP_MIN));
        if (idx >= 0 && idx < STEPS) buckets[idx] += c;
      }
      const spans: [number, number][] = [];
      for (let i = 0; i + 1 < s.aliveSpans.length; i += 2) spans.push([s.aliveSpans[i]!, s.aliveSpans[i + 1]!]);
      return { name: s.name, buckets, aliveSpans: spans };
    })
    .filter((s) => s.buckets.some((v) => v > 0))
    .sort((a, b) => b.buckets.reduce((x, y) => x + y, 0) - a.buckets.reduce((x, y) => x + y, 0)),
);
/** 实际绘制的行（Top-K 截断后） */
const topRows = computed(() => rows.value.slice(0, maxRows.value));

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

/** 单格最大计数（色阶上限，基于绘制中的 Top-K 行） */
const maxCell = computed(() => topRows.value.reduce((acc, r) => Math.max(acc, ...r.buckets), 0));

/** 热力图数据：[列索引, 行索引, log 变换后的计数]，0 桶不给数据（保持空白）。log 变换拉开低值区分度，否则 1~10 次的格子全被挤在最浅一档分不清 */
const heatData = computed(() => {
  const data: [number, number, number][] = [];
  topRows.value.forEach((r, y) => {
    r.buckets.forEach((v, x) => {
      if (v > 0) data.push([x, y, Math.log10(v) + 1]);
    });
  });
  return data;
});

/** 每行 24h 小计（图下列表用） */
const rowTotals = computed(() => topRows.value.map((r) => r.buckets.reduce((a, b) => a + b, 0)));

/** 窗口起点（毫秒）与进行中的区间 end 替换值 */
const windowStart = computed(() => now.value - 24 * 3600_000);

/** 每行每桶的存活覆盖率（0~1）：把存活区间与桶求交，算重叠时长占比 */
const aliveCoverage = computed(() =>
  topRows.value.map((r) => {
    const winStart = windowStart.value;
    return r.buckets.map((_, x) => {
      const bStart = winStart + x * STEP_MIN * 60_000;
      const bEnd = bStart + STEP_MIN * 60_000;
      let cover = 0;
      for (const [s, e] of r.aliveSpans) {
        const spanEnd = e < 0 ? now.value : e;
        const overlap = Math.min(spanEnd, bEnd) - Math.max(s, bStart);
        if (overlap > 0) cover += overlap;
      }
      return Math.min(cover / (STEP_MIN * 60_000), 1);
    });
  }),
);

/** 存活条数据：把每行相邻有存活覆盖的桶合并成连续区间，一次画一整段（连续存活无缝隙）
 *  value = [起始桶x, 行y, 平均覆盖率, 结束桶x] */
const aliveData = computed(() => {
  const data: { value: [number, number, number, number] }[] = [];
  aliveCoverage.value.forEach((covs, y) => {
    let runStart = -1;
    let covSum = 0;
    const flush = (endX: number) => {
      if (runStart >= 0) data.push({ value: [runStart, y, covSum / (endX - runStart + 1), endX] });
      runStart = -1;
      covSum = 0;
    };
    covs.forEach((cov, x) => {
      if (cov > 0) {
        if (runStart < 0) runStart = x;
        covSum += cov;
      } else {
        flush(x - 1);
      }
    });
    flush(covs.length - 1);
  });
  return data;
});

/** 存活条渲染：每个连续区间画一条 3px 高的绿色长条，覆盖率决定不透明度（连续绿线=一直存活，缺口=进程重启/停机） */
interface RenderItemParams {
  value: [number, number, number, number];
}
interface RenderItemApi {
  /** 类目坐标转像素坐标 */
  coord: (v: number[]) => number[];
  /** 类目尺度转像素尺寸 */
  size: (v: number[]) => number[];
}
function renderAliveBar(
  _params: RenderItemParams,
  api: RenderItemApi & { /** 取数据项第 dim 维的值 */ value: (dim: number) => number },
): Record<string, unknown> {
  const xStart = api.value(0);
  const y = api.value(1);
  const cov = api.value(2);
  const xEnd = api.value(3);
  const point = api.coord([xStart, y]);
  const pointEnd = api.coord([xEnd, y]);
  const cellW = api.size([1, 0])[0];
  const bandH = api.size([0, 1])[0];
  const barH = 3;
  const left = point[0] - cellW / 2;
  const width = pointEnd[0] - point[0] + cellW;
  const barY = point[1] + bandH / 2 - barH;
  return {
    type: 'group',
    children: [
      {
        /** 可见的绿色存活条：紧贴蓝色格子底边；emphasis 由 series 的 emphasis.itemStyle 全局接管 */
        type: 'rect',
        shape: { x: left, y: barY, width, height: barH },
        style: { fill: '#1a7f37', opacity: 0.35 + 0.65 * cov },
      },
      {
        /** 透明命中区（绿条太细难以 hover），拾取后触发同一数据项的 tooltip */
        type: 'rect',
        shape: { x: left, y: barY - 6, width, height: barH + 12 },
        style: { fill: 'rgba(0,0,0,0)' },
        silent: false,
      },
    ],
  };
}

const option = computed(() => ({
  tooltip: {
    /** 悬停格子：时间 + 服务 + 该 15 分钟请求数（显示原始值，log 只用于染色） */
    formatter: (p: { data: unknown; seriesType?: string }) => {
      /** data 项可能是裸数组或 {value:[...]} 对象（custom series），统一取出值数组 */
      const raw = Array.isArray(p.data) ? p.data : (p.data as { value?: number[] })?.value;
      if (!Array.isArray(raw)) return '';
      if (p.seriesType === 'custom') {
        const [xStart, y, cov, xEnd] = raw as [number, number, number, number];
        /** 区间末端：最后一桶的终点越出窗口时显示「现在」 */
        const endLabel = xEnd + 1 >= STEPS ? '现在' : bucketTime(xEnd + 1);
        const range = xStart === xEnd ? `${bucketTime(xStart)} 起的 15 分钟` : `${bucketTime(xStart)} ~ ${endLabel}`;
        return `<b>${topRows.value[y]?.name ?? ''}</b><br/>${range}<br/>存活覆盖率 ${Math.round(cov * 100)}%`;
      }
      const [x, y, lv] = raw as [number, number, number];
      const v = Math.round(10 ** (lv - 1));
      return `<b>${topRows.value[y]?.name ?? ''}</b><br/>${bucketTime(x)} 起的 15 分钟<br/>${v} 次请求`;
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
    data: topRows.value.map((r) => r.name),
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
    {
      /** 存活状态条：custom series 绘制在每行底部，绿色连续 = 进程一直存活，缺口 = 停机/重启
       *  hover 选中效果与热力格子一致：描边高亮 + 绿条加粗 */
      type: 'custom',
      renderItem: renderAliveBar,
      data: aliveData.value,
      silent: false,
      clip: true,
      z: 3,
      emphasis: {
        itemStyle: { opacity: 1 },
        /** 命中区也放大，视觉反馈更明显 */
      },
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
        <select v-model.number="maxRows" class="g-panel-select" title="展示流量最高的前 N 个服务">
          <option v-for="n in ROW_OPTIONS" :key="n" :value="n">Top {{ n }}</option>
        </select>
      </div>
    </div>
    <div ref="chartEl" class="g-chart" :style="{ height: `${Math.max(topRows.length, 1) * 26 + 40}px` }" />
    <p v-if="truncatedCount > 0" class="g-empty" style="margin: 0 0 4px">仅绘制流量 Top-{{ Math.min(maxRows, topRows.length) }}，其余 {{ truncatedCount }} 个低流量服务未展示（可搜索定位）</p>
    <div v-if="topRows.length" class="g-rows">
      <span v-for="(r, i) in topRows" :key="r.name" class="g-row-item">
        {{ r.name }} <b>{{ rowTotals[i] }}</b>
      </span>
    </div>
    <p v-if="!topRows.length" class="g-empty">最近 24 小时暂无请求数据</p>
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
