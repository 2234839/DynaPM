<script setup lang="ts">
import { computed } from 'vue';
import { HeatmapChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, VisualMapComponent } from 'echarts/components';
import { use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEChart } from './composables/echarts';
import { pairs } from './utils';

use([HeatmapChart, GridComponent, TooltipComponent, VisualMapComponent, CanvasRenderer]);

/** 服务进程资源指标 */
interface ProcMetrics {
  pid: number;
  cpuPercent: number;
  cpuSeconds: number;
  rssMb: number;
}

/** 单个服务的历史统计（与 api.ts 同构；扁平编码） */
export interface ServiceStats {
  name: string;
  /** 聚合分钟桶扁平数组 [minuteEpoch, count, …] */
  reqBuckets: number[];
  /** 存活区间扁平数组 [startMs, endMs, …]，进行中由后端裁剪到窗口末尾 */
  aliveSpans: number[];
  /** 进程资源（不在线为 null） */
  proc?: ProcMetrics | null;
}

const props = defineProps<{ stats: ServiceStats }>();

/** 当前时间（响应式刷新由父组件轮询驱动） */
const now = Date.now();

/** 最近 24h 存活时间轴：把区间与窗口求交 */
const timeline = computed(() => {
  const winStart = now - 24 * 3600_000;
  const total = 24 * 3600_000;
  return pairs(props.stats.aliveSpans)
    .map(([s, e]) => {
      const end = e < 0 ? now : e;
      return [Math.max(s, winStart), Math.min(end, now)] as [number, number];
    })
    .filter(([s, e]) => e > s)
    .map(([s, e]) => ({
      left: ((s - winStart) / total) * 100,
      width: ((e - s) / total) * 100,
    }));
});

/** 24h 内在线时长（小时） */
const aliveHours24h = computed(() => {
  const winStart = now - 24 * 3600_000;
  return (
    pairs(props.stats.aliveSpans).reduce((acc, [s, e]) => {
      const end = e < 0 ? now : e;
      return acc + Math.max(0, Math.min(end, now) - Math.max(s, winStart));
    }, 0) / 3600_000
  );
});

/** 分钟桶聚合到小时桶：7 天 x 24 小时，key = hourIndex(0=6天前的0点对齐) */
const hourBuckets = computed(() => {
  const map = new Map<number, number>();
  const hourNow = Math.floor(now / 3600_000);
  for (const [m, c] of pairs(props.stats.reqBuckets)) {
    const h = Math.floor(m / 60);
    if (h > hourNow) continue;
    map.set(h, (map.get(h) ?? 0) + c);
  }
  return map;
});

/** 热力图格子：[hour, dayIdx(0=6天前..6=今天), count] */
const heatCells = computed(() => {
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const dayStartMs = todayStart.getTime();
  const cells: [number, number, number][] = [];
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const h = Math.floor((dayStartMs - (6 - day) * 86400_000 + hour * 3600_000) / 3600_000);
      cells.push([hour, day, hourBuckets.value.get(h) ?? 0]);
    }
  }
  return cells;
});
/** 24h 请求总数 */
const total24h = computed(() => {
  const hourNow = Math.floor(now / 3600_000);
  let sum = 0;
  for (const [m, c] of pairs(props.stats.reqBuckets)) if (Math.floor(m / 60) > hourNow - 24) sum += c;
  return sum;
});

/** Y 轴日期标签（6 天前 → 今天） */
const dayLabels = Array.from({ length: 7 }, (_, i) =>
  new Date(now - (6 - i) * 86400_000).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }),
);

/** 时间轴小时刻度（0/6/12/18/24） */
const ticks = [0, 6, 12, 18, 23];

/** echarts 热力图配置：悬停看详细，visualMap 可拖动筛流量阈值 */
const option = computed(() => ({
  tooltip: {
    position: 'top',
    /** p.data = [hour, dayIdx, count] */
    formatter: (p: { data: [number, number, number] }) => {
      const [hour, dayIdx, count] = p.data;
      const d = new Date(now - (6 - dayIdx) * 86400_000);
      return `${d.getMonth() + 1}/${d.getDate()} ${String(hour).padStart(2, '0')}:00 · ${count} 次`;
    },
  },
  grid: { left: 44, right: 16, top: 8, bottom: 40 },
  xAxis: {
    type: 'category',
    data: Array.from({ length: 24 }, (_, h) => (h % 3 === 0 ? `${String(h).padStart(2, '0')}时` : '')),
    splitArea: { show: false },
    axisLabel: { fontSize: 10, color: '#8b949e' },
    axisTick: { show: false },
    axisLine: { show: false },
  },
  yAxis: {
    type: 'category',
    data: dayLabels,
    splitArea: { show: false },
    axisLabel: { fontSize: 10, color: '#8b949e' },
    axisTick: { show: false },
    axisLine: { show: false },
  },
  visualMap: {
    min: 0,
    max: Math.max(1, ...heatCells.value.map(([, , v]) => v)),
    calculable: true,
    orient: 'horizontal',
    left: 'center',
    bottom: 0,
    itemHeight: 80,
    textStyle: { fontSize: 10, color: '#8b949e' },
    inRange: { color: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'] },
  },
  series: [
    {
      type: 'heatmap',
      data: heatCells.value,
      label: { show: false },
      itemStyle: { borderColor: '#fff', borderWidth: 1, borderRadius: 2 },
      emphasis: { itemStyle: { shadowBlur: 4, shadowColor: 'rgba(0,0,0,0.3)' } },
    },
  ],
}));

/** 图表容器 */
const chartEl = useEChart(option);
</script>

<template>
  <div class="charts">
    <div v-if="props.stats.proc" class="metrics-row">
      <span class="metric">PID <b>{{ props.stats.proc.pid }}</b></span>
      <span class="metric">CPU <b :class="{ 'metric-warn': props.stats.proc.cpuPercent > 80 }">{{ props.stats.proc.cpuPercent }}%</b></span>
      <span class="metric">内存 <b>{{ props.stats.proc.rssMb }} MB</b></span>
      <span class="metric">CPU 累计 <b>{{ props.stats.proc.cpuSeconds }}s</b></span>
    </div>
    <div class="chart-block">
      <div class="chart-title">
        存活时段（最近 24h · 在线 {{ aliveHours24h.toFixed(1) }}h）
      </div>
      <div class="timeline">
        <div class="timeline-track">
          <div
            v-for="(seg, i) in timeline"
            :key="i"
            class="timeline-seg"
            :style="{ left: `${seg.left}%`, width: `${seg.width}%` }"
          />
        </div>
        <div class="timeline-ticks">
          <span v-for="h in ticks" :key="h" :style="{ left: `${(h / 23) * 100}%` }">{{ h }}h</span>
        </div>
      </div>
    </div>

    <div class="chart-block">
      <div class="chart-title">请求热力图（最近 7 天 · 每格 1 小时 · 24h 共 {{ total24h }} 次）</div>
      <div ref="chartEl" class="heat-chart" />
    </div>
  </div>
</template>

<style scoped>
.charts {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.metrics-row {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: #57606a;
  flex-wrap: wrap;
}
.metric b {
  color: #1f2328;
}
.metric-warn {
  color: #cf222e;
}
.chart-block {
  background: #f6f8fa;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  padding: 10px 12px;
}
.chart-title {
  font-size: 12px;
  color: #57606a;
  margin-bottom: 8px;
}
.timeline-track {
  position: relative;
  height: 18px;
  background: #ebedf0;
  border-radius: 3px;
  overflow: hidden;
}
.timeline-seg {
  position: absolute;
  top: 0;
  bottom: 0;
  background: #30a14e;
  border-radius: 1px;
}
.timeline-ticks {
  position: relative;
  height: 14px;
  font-size: 10px;
  color: #8b949e;
}
.timeline-ticks span {
  position: absolute;
  transform: translateX(-50%);
}
.timeline-ticks span:last-child {
  transform: none;
}
.heat-chart {
  width: 100%;
  height: 200px;
}
</style>
