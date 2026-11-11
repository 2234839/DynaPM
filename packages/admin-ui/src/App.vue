<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  fetchServices,
  fetchStats,
  captureTokenFromHash,
  getToken,
  clearToken,
  setToken,
  localClient,
  type AdminClient,
  type ServiceListItem,
  type ServiceDetail,
  type ServiceStats,
} from './api';
import { persistedRef } from './persistedRef';
import { formatDuration } from './utils';
import { usePagination } from './composables/usePagination';
import StatsCharts from './StatsCharts.vue';
import GlobalChart from './GlobalChart.vue';
import ConfigEditor from './ConfigEditor.vue';
import AppDialog from './components/AppDialog.vue';
import { confirmDialog } from './composables/dialog';
import { loadPanels, PanelClient, type RemotePanel } from './panels';
import PanelManager from './components/PanelManager.vue';

/** URL hash 中的令牌持久化后清除地址栏 */
captureTokenFromHash();

/** 是否已持有令牌（未持有显示登录界面） */
const authed = ref(!!getToken());
/** 手动输入的令牌 */
const tokenInput = ref('');

/** 服务列表 */
const services = ref<ServiceListItem[]>([]);
/** 展开详情的服务名 -> 详情 */
const details = ref<Map<string, ServiceDetail>>(new Map());
const loading = ref(false);
const error = ref('');
/** 操作中的服务名（按钮禁用） */
const busy = ref('');
const expanded = ref<Set<string>>(new Set());
/** 各服务历史统计（图表数据，键为聚合行 uid） */
const statsMap = ref<Map<string, ServiceStats>>(new Map());
/** 服务列表变更代数游标：未变时网关返回空列表，跳过万级服务的整表重渲染 */
let epochCursor: number | undefined;
/** SSE 订阅与刷新防抖句柄 */
let eventSource: EventSource | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** 远程面板列表（localStorage 持久化） */
const remotePanels = ref<RemotePanel[]>(loadPanels());
/** 各远程面板拉取结果：面板 id -> 服务列表或错误 */
const remoteData = ref<Map<string, { services: ServiceListItem[]; error: string }>>(new Map());
/** 面板管理对话框可见性 */
const panelManagerOpen = ref(false);

/** 聚合行：本地面板 + 各远程面板的服务统一行模型 */
interface FedRow {
  /** 唯一键：local:<name> 或 <panelId>:<name> */
  uid: string;
  /** 所属面板 id（本地为空串） */
  panelId: string;
  /** 所属面板显示名（本地为空串） */
  panelName: string;
  /** 是否来自远程面板 */
  remote: boolean;
  /** 服务数据 */
  svc: ServiceListItem;
}

/** 聚合后的完整服务行列表 */
const fedRows = computed<FedRow[]>(() => [
  ...services.value.map((s) => ({ uid: `local:${s.name}`, panelId: '', panelName: '', remote: false, svc: s })),
  ...remotePanels.value.flatMap((p) =>
    (remoteData.value.get(p.id)?.services ?? []).map(
      (s): FedRow => ({ uid: `${p.id}:${s.name}`, panelId: p.id, panelName: p.name, remote: true, svc: s }),
    ),
  ),
]);

/** 各远程面板的拉取错误（表内以提示行展示） */
const panelErrors = computed(() =>
  remotePanels.value
    .map((p) => ({ id: p.id, name: p.name, error: remoteData.value.get(p.id)?.error ?? '' }))
    .filter((x) => x.error),
);

/** 拉取全部远程面板的服务列表（单面板失败不影响其他面板） */
async function refreshRemote(): Promise<void> {
  const entries = await Promise.all(
    remotePanels.value.map(async (p): Promise<readonly [string, { services: ServiceListItem[]; error: string }]> => {
      try {
        const data = await new PanelClient(p).fetchServices();
        return [p.id, { services: data.services ?? [], error: '' }] as const;
      } catch (e) {
        const msg = e instanceof Error && e.message === 'UNAUTHORIZED' ? '令牌无效（401）' : e instanceof Error ? e.message : String(e);
        return [p.id, { services: [], error: msg }] as const;
      }
    }),
  );
  remoteData.value = new Map(entries);
}

/** 全局折线图数据：所有聚合行的分钟请求桶（远程行名称加面板前缀） */
const globalSeries = computed(() =>
  fedRows.value.map((r) => ({
    name: r.remote ? `${r.panelName}/${r.svc.name}` : r.svc.name,
    reqBuckets: statsMap.value.get(r.uid)?.reqBuckets ?? [],
    aliveSpans: statsMap.value.get(r.uid)?.aliveSpans ?? [],
    panelName: r.remote ? r.panelName : '',
  })),
);

/** 服务名搜索关键字（不区分大小写，空串 = 不过滤） */
const searchKw = ref('');
/** 面板筛选：空串 = 全部；'local' = 仅本地；否则为面板 id（用户选择本地持久化） */
const filterPanel = persistedRef('table.filterPanel', '');
/** 状态筛选：空串 = 全部；否则为 online/offline/starting/stopping/disabled（用户选择本地持久化） */
const statusFilter = persistedRef('table.statusFilter', '');
/** 状态筛选选项（含当前计数，空串代表全部） */
const statusOptions = computed(() => {
  const count = (s: string) => fedRows.value.filter((r) => (r.svc.paused ? 'disabled' : r.svc.status) === s).length;
  return [
    { id: '', name: '全部' },
    { id: 'online', name: `在线 ${count('online')}` },
    { id: 'offline', name: `离线 ${count('offline')}` },
    { id: 'starting', name: `启动中 ${count('starting')}` },
    { id: 'stopping', name: `停止中 ${count('stopping')}` },
    { id: 'disabled', name: `已关停 ${count('disabled')}` },
  ];
});

/** 筛选下拉选项：本地 + 各远程面板（含服务计数） */
const panelOptions = computed(() => [
  { id: '', name: '全部面板', count: fedRows.value.length },
  { id: 'local', name: '本地', count: fedRows.value.filter((r) => !r.remote).length },
  ...remotePanels.value.map((p) => ({
    id: p.id,
    name: p.name,
    count: fedRows.value.filter((r) => r.panelId === p.id).length,
  })),
]);

/** 搜索 + 面板/状态筛选后的聚合行 */
const visibleRows = computed(() => {
  const kw = searchKw.value.trim().toLowerCase();
  return fedRows.value.filter((r) => {
    if (filterPanel.value === 'local' && r.remote) return false;
    if (filterPanel.value && filterPanel.value !== 'local' && r.panelId !== filterPanel.value) return false;
    if (statusFilter.value && (r.svc.paused ? 'disabled' : r.svc.status) !== statusFilter.value) return false;
    if (kw && !r.svc.name.toLowerCase().includes(kw) && !(r.remote && r.panelName.toLowerCase().includes(kw))) return false;
    return true;
  });
});
/** 排序字段（svc 属性名）与方向；空字段 = 默认顺序（用户选择本地持久化） */
const sortKey = persistedRef('table.sortKey', '');
const sortAsc = persistedRef('table.sortAsc', true);
/** 排序键取值：status 按运行状态优先级，其余按数值/字符串通比较 */
const STATUS_ORDER: Record<string, number> = { online: 0, starting: 1, stopping: 2, offline: 3, disabled: 4 };
function sortValue(r: FedRow, key: string): number | string {
  const s = r.svc as unknown as Record<string, unknown>;
  if (key === 'status') return STATUS_ORDER[r.svc.paused ? 'disabled' : r.svc.status] ?? 9;
  const v = s[key];
  return typeof v === 'number' ? v : String(v ?? '');
}
/** 排序后的行（分页前） */
const sortedRows = computed(() => {
  if (!sortKey.value) return visibleRows.value;
  const key = sortKey.value;
  const dir = sortAsc.value ? 1 : -1;
  return [...visibleRows.value].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });
});
/** 行 -> 面板 API 客户端路由：本地行走 localClient，远程行按 panelId 构造 PanelClient（唯一收口处） */
function clientFor(row: FedRow): AdminClient {
  return row.remote ? new PanelClient(remotePanels.value.find((p) => p.id === row.panelId)!) : localClient;
}

/** 每页行数选项与默认值：万级服务全量渲染会拖死主线程，分页控制单次 DOM 规模（筛选/排序变化自动回第一页） */
const { pageSize, pageNo, totalPages, renderedSlice: renderedRows, gotoPage, PAGE_SIZE_OPTIONS } = usePagination(
  () => sortedRows.value,
  'table.pageSize',
  50,
  [searchKw, filterPanel, statusFilter, sortKey],
);
/** 点击表头切换排序：同列循环 升序→降序→取消 */
function toggleSort(key: string): void {
  if (sortKey.value !== key) {
    sortKey.value = key;
    sortAsc.value = true;
  } else if (sortAsc.value) {
    sortAsc.value = false;
  } else {
    sortKey.value = '';
  }
}
/** 表头排序指示符 */
function sortMark(key: string): string {
  if (sortKey.value !== key) return '↕';
  return sortAsc.value ? '↑' : '↓';
}
/** 配置编辑器可见性 */
const configOpen = ref(false);
/** 正在原地编辑配置的服务（聚合行 uid，detail-grid 直接切输入态） */
const editingSvc = ref('');
/** 编辑表单：超时用秒展示，存储为毫秒 */
const editForm = ref({
  host: '',
  base: '',
  healthType: '',
  idleSec: 0,
  startSec: 0,
  startCommand: '',
  stopCommand: '',
});
/** 编辑态错误与保存中标志 */
const editError = ref('');
const editSaving = ref(false);

/** 进入原地编辑：拉取配置定位该服务条目填充表单（本地/远程面板同构 API） */
async function startEdit(row: FedRow): Promise<void> {
  editError.value = '';
  const client = clientFor(row);
  const name = row.svc.name;
  try {
    const [detail, cfg] = await Promise.all([client.fetchServiceDetail(name), client.fetchConfig()]);
    /** 配置键是 host（面板 name 可能是 base 地址），从详情取 host 定位 */
    const host = (detail.host as string) ?? name;
    const svc = cfg.services?.[host];
    if (!svc) {
      editError.value = `配置中找不到服务 ${host}`;
      return;
    }
    editForm.value = {
      host,
      base: svc.base ?? '',
      healthType: svc.healthCheck?.type ?? '',
      idleSec: Math.round((svc.idleTimeout ?? 0) / 1000),
      startSec: Math.round((svc.startTimeout ?? 60000) / 1000),
      startCommand: svc.commands?.start ?? '',
      stopCommand: svc.commands?.stop ?? '',
    };
    editingSvc.value = row.uid;
  } catch (e) {
    editError.value = e instanceof Error ? e.message : String(e);
  }
}

/** 保存原地编辑：改写配置内该服务条目后整体 PUT（服务/超时变更均可热更；远程面板写入对方网关） */
async function saveEdit(): Promise<void> {
  editError.value = '';
  const f = editForm.value;
  if (!f.base.trim()) {
    editError.value = '后端地址不能为空';
    return;
  }
  const row = fedRows.value.find((r) => r.uid === editingSvc.value);
  if (!row) {
    editError.value = '编辑目标已不存在';
    return;
  }
  const client = clientFor(row);
  const getConfig = () => client.fetchConfig();
  const putConfig = (cfg: Record<string, any>) => client.saveConfig(cfg);
  editSaving.value = true;
  try {
    const cfg = await getConfig();
    const svc = cfg.services?.[f.host];
    if (!svc) {
      editError.value = `配置中找不到服务 ${f.host}（可能已被外部修改）`;
      return;
    }
    svc.base = f.base.trim();
    if (f.healthType) {
      svc.healthCheck = { ...(svc.healthCheck ?? {}), type: f.healthType };
    } else {
      delete svc.healthCheck;
    }
    svc.idleTimeout = f.idleSec * 1000;
    svc.startTimeout = f.startSec * 1000;
    svc.commands = { ...(svc.commands ?? {}) };
    if (f.startCommand) svc.commands.start = f.startCommand;
    else delete svc.commands.start;
    if (f.stopCommand) svc.commands.stop = f.stopCommand;
    else delete svc.commands.stop;
    const res = await putConfig(cfg);
    if (!res.reloaded) {
      // 含监听地址变更触发网关自重启：远程面板提示后仅收起编辑态，不刷新本页；本地等重启后刷新
      if (row.remote) {
        editingSvc.value = '';
        editError.value = '';
        error.value = `[${row.panelName}] 保存成功，对方网关正在重启加载新配置…`;
        setTimeout(() => {
          error.value = '';
          refresh();
        }, 5000);
        return;
      }
      editError.value = '保存成功，网关正在重启加载新配置…';
      setTimeout(() => location.reload(), 3000);
      return;
    }
    const uid = editingSvc.value;
    editingSvc.value = '';
    await refresh();
    const updated = fedRows.value.find((r) => r.uid === uid);
    if (updated && expanded.value.has(uid)) await toggleDetail(updated);
  } catch (e) {
    editError.value = e instanceof Error ? e.message : String(e);
  } finally {
    editSaving.value = false;
  }
}

/** 加载服务列表（本地 + 全部远程面板；本地侧用 epoch 游标，无变更时沿用旧数据跳过重渲染） */
async function refresh(): Promise<void> {
  loading.value = true;
  error.value = '';
  refreshRemote();
  try {
    const data = await fetchServices(epochCursor);
    const unchanged = data.epoch != null && epochCursor === data.epoch && !data.services.length;
    if (!unchanged) {
      services.value = data.services ?? [];
      epochCursor = data.epoch;
    }
    authed.value = true;
  } catch (e) {
    if (e instanceof Error && e.message === 'UNAUTHORIZED') {
      authed.value = false;
    } else {
      error.value = e instanceof Error ? e.message : String(e);
    }
  } finally {
    loading.value = false;
  }
}

/** 订阅网关 SSE 事件流：服务启停/关停等变更到达时防抖 500ms 刷新列表，
 *  替代高频轮询——万级服务下轮询意味着每次全量重建响应式数据 */
function subscribeEvents(): void {
  eventSource?.close();
  const token = getToken();
  eventSource = new EventSource(`/_dynapm/api/events${token ? `?token=${encodeURIComponent(token)}` : ''}`);
  eventSource.onmessage = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 500);
  };
  // 连接断开时依赖 30s 兜底轮询恢复，无需重连逻辑（EventSource 自动重连）
}

/** 退出登录 */
function logout(): void {
  clearToken();
  authed.value = false;
  services.value = [];
  epochCursor = undefined;
  eventSource?.close();
  eventSource = null;
}

/** 手动输入令牌登录：先存再验证 */
async function login(): Promise<void> {
  error.value = '';
  const token = tokenInput.value.trim();
  if (!token) return;
  setToken(token);
  loading.value = true;
  try {
    const data = await fetchServices();
    services.value = data.services ?? [];
    epochCursor = data.epoch;
    authed.value = true;
    tokenInput.value = '';
  } catch (e) {
    clearToken();
    error.value = e instanceof Error && e.message === 'UNAUTHORIZED' ? '令牌无效' : `验证失败: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    loading.value = false;
  }
}

/** 展开或收起服务详情（按聚合行路由到本地或远程 API） */
async function toggleDetail(row: FedRow): Promise<void> {
  const key = row.uid;
  if (expanded.value.has(key)) {
    expanded.value.delete(key);
    expanded.value = new Set(expanded.value);
    return;
  }
  try {
    const detail = await clientFor(row).fetchServiceDetail(row.svc.name);
    details.value.set(key, detail);
    expanded.value = new Set(expanded.value).add(key);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/** 服务操作统一入口：按行路由客户端执行动作，成功后刷新，全程锁定该行按钮 */
async function runAction(row: FedRow, action: 'startService' | 'stopService' | 'disableService' | 'enableService'): Promise<void> {
  busy.value = row.uid;
  try {
    await clientFor(row)[action](row.svc.name);
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = '';
  }
}

/** 启动服务 */
function onStart(row: FedRow): Promise<void> {
  return runAction(row, 'startService');
}

/** 停止服务（下次请求会自动按需拉起） */
function onStop(row: FedRow): Promise<void> {
  return runAction(row, 'stopService');
}

/** 彻底关停（停止并禁止按需拉起） */
async function onDisable(row: FedRow): Promise<void> {
  const scope = row.remote ? `远程面板「${row.panelName}」的服务` : '服务';
  if (!(await confirmDialog(`彻底关停${scope} ${row.svc.name}？之后请求到达不会自动拉起，需手动解除。`, { danger: true, okText: '彻底关停' }))) return;
  await runAction(row, 'disableService');
}

/** 解除彻底关停 */
function onEnable(row: FedRow): Promise<void> {
  return runAction(row, 'enableService');
}

/** 状态徽标样式类 */
function statusClass(status: string): string {
  return `status-${status}`;
}


/** 启动耗时格式化：秒级显示（冷启动排障用） */
function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** 存活/回收合并单元格文案：online 显示存活时长+回收倒计时，已停回退显示历史累计存活 */
function uptimeCell(svc: ServiceListItem): { main: string; sub: string | null; title: string } {
  if (svc.status === 'online') {
    const main = formatDuration(svc.uptime);
    if (svc.idleRemainingMs == null) return { main, sub: null, title: '有活跃连接，不回收' };
    const sub = svc.idleRemainingMs <= 60_000 ? `${Math.ceil(svc.idleRemainingMs / 1000)}s后停` : `${formatDuration(svc.idleRemainingMs)}后停`;
    return { main, sub, title: `闲置 ${formatDuration(svc.idleTimeout)} 后自动停止，剩余 ${formatDuration(svc.idleRemainingMs)}` };
  }
  if (svc.totalUptime) return { main: '总 ' + formatDuration(svc.totalUptime), sub: null, title: '历史累计存活时间' };
  return { main: '-', sub: null, title: '' };
}

/** 倒计时样式：临近回收（<1 分钟）高亮 */
function idleClass(svc: ServiceListItem): string {
  const r = svc.idleRemainingMs;
  return r != null && r <= 60_000 ? 'idle-soon' : 'idle-far';
}

/** 拉取历史统计（图表，本地 + 全部远程面板，键为聚合行 uid）。
 *  只拉热力图需要的 24h 窗口，万级服务下全量 8 天桶体积/解析成本不可接受 */
async function refreshStats(): Promise<void> {
  const next = new Map<string, ServiceStats>();
  const fromMin = Math.floor(Date.now() / 60_000) - 25 * 60;
  try {
    const data = await fetchStats(fromMin);
    for (const s of data.services ?? []) next.set(`local:${s.name}`, s);
  } catch {
    // 图表数据拉取失败不打断主列表
  }
  await Promise.all(
    remotePanels.value.map(async (p) => {
      try {
        const data = await new PanelClient(p).fetchStats(fromMin);
        for (const s of data.services ?? []) next.set(`${p.id}:${s.name}`, s);
      } catch {
        // 远程面板统计失败不影响本地面板图表
      }
    }),
  );
  statsMap.value = next;
}

/** 面板列表保存后：重载配置并立即刷新聚合数据 */
function onPanelsChanged(): void {
  remotePanels.value = loadPanels();
  refresh();
  refreshStats();
}

/** 配置保存成功（网关自重启后延迟刷新列表与图表） */
function onSaved(): void {
  setTimeout(() => {
    refresh();
    refreshStats();
  }, 4000);
}

/** 格式化时间戳为本地时间 */
function formatTime(ms?: number): string {
  if (!ms) return '-';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/** 服务可访问地址（域名路由优先，无则 null）。
 *  http 而非 https：本地 dev 域名（*.localhost）只有 HTTP 80，浏览器强制 https 会连接被拒 */
function serviceUrl(svc: ServiceListItem): string | null {
  const host = svc.hosts?.[0];
  return host ? `http://${host}/` : null;
}

onMounted(() => {
  refresh();
  refreshStats();
  subscribeEvents();
  // SSE 主通道 + 30s 兜底轮询（断连/漏事件时恢复）
  const statsTimer = setInterval(refreshStats, 30_000);
  onUnmounted(() => {
    clearInterval(statsTimer);
    eventSource?.close();
    eventSource = null;
  });
});
</script>

<template>
  <!-- 未持令牌：登录门禁 -->
  <div v-if="!authed" class="container login-box">
    <h1>DynaPM 管理界面</h1>
    <p class="login-hint">请输入管理令牌，或使用带 <code>#token=...</code> 的完整地址访问</p>
    <form class="login-form" @submit.prevent="login">
      <input
        v-model="tokenInput"
        class="login-input"
        type="password"
        placeholder="管理令牌"
        autocomplete="off"
        autofocus
      />
      <button class="btn" type="submit" :disabled="loading || !tokenInput.trim()">
        {{ loading ? '验证中…' : '进入' }}
      </button>
    </form>
    <p v-if="error" class="error">{{ error }}</p>
  </div>

  <div v-else class="container">
    <header class="header">
      <h1>DynaPM 管理界面</h1>
      <div>
        <button class="btn" :disabled="loading" @click="refresh">
          {{ loading ? '刷新中…' : '手动刷新' }}
        </button>
        <button class="btn" @click="configOpen = !configOpen">配置</button>
        <button class="btn" @click="panelManagerOpen = !panelManagerOpen">面板管理</button>
        <button class="btn" @click="logout">退出</button>
      </div>
    </header>

    <ConfigEditor v-if="configOpen" @close="configOpen = false" @saved="onSaved" />
    <PanelManager v-if="panelManagerOpen" @close="panelManagerOpen = false" @saved="onPanelsChanged" />

    <p v-if="error" class="error">{{ error }}</p>

    <table class="service-table">
      <thead>
        <tr>
          <th>
            <div class="name-filter">
              <div class="filter-group">
                <input
                  v-model="searchKw"
                  class="search-input"
                  type="search"
                  placeholder="搜索服务/面板…"
                />
                <select v-model="filterPanel" class="panel-select" title="按面板筛选">
                  <option v-for="o in panelOptions" :key="o.id || 'all'" :value="o.id">
                    {{ o.name }} {{ o.count }}
                  </option>
                </select>
              </div>
            </div>
          </th>
          <th>
            <select v-model="statusFilter" class="panel-select" title="按状态筛选">
              <option v-for="o in statusOptions" :key="o.id || 'all'" :value="o.id">{{ o.name }}</option>
            </select>
          </th>
          <th>存活 / 回收 <button class="th-sort" title="按存活时长排序" @click="toggleSort('uptime')">{{ sortMark('uptime') }}</button></th>
          <th>请求数 <button class="th-sort" title="按累计请求数排序" @click="toggleSort('requestCount')">{{ sortMark('requestCount') }}</button></th>
          <th title="最近一次冷启动耗时">启动耗时 <button class="th-sort" title="按最近启动耗时排序" @click="toggleSort('lastStartDurationMs')">{{ sortMark('lastStartDurationMs') }}</button></th>
          <th>连接数 <button class="th-sort" title="按活跃连接数排序" @click="toggleSort('activeConnections')">{{ sortMark('activeConnections') }}</button></th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in renderedRows" :key="row.uid">
          <tr>
            <td class="name-cell">
              <button class="link arrow" :title="expanded.has(row.uid) ? '收起详情' : '展开详情'" @click="toggleDetail(row)">
                {{ expanded.has(row.uid) ? '▼' : '▶' }}
              </button>
              <a
                v-if="serviceUrl(row.svc)"
                class="svc-link"
                :href="serviceUrl(row.svc)!"
                target="_blank"
                rel="noopener"
              >{{ row.svc.name }}</a>
              <span v-else>{{ row.svc.name }}</span>
              <span v-if="row.remote" class="badge panel-badge" :title="`来自远程面板 ${row.panelName}`">{{ row.panelName }}</span>
              <span v-if="row.svc.socks" class="badge port-badge" title="SOCKS5 代理端口">🧦 :{{ row.svc.ports?.[0] }}</span>
              <span v-else-if="row.svc.ports?.length" class="badge port-badge" title="专属端口">:{{ row.svc.ports[0] }}</span>
            </td>
            <td>
              <span class="badge" :class="row.svc.paused ? 'status-disabled' : statusClass(row.svc.status)">{{ row.svc.paused ? 'disabled' : row.svc.status }}</span>
            </td>
            <td class="uptime-cell" :title="uptimeCell(row.svc).title">
              <span>{{ uptimeCell(row.svc).main }}</span>
              <span v-if="uptimeCell(row.svc).sub" class="idle-sub" :class="idleClass(row.svc)">{{ uptimeCell(row.svc).sub }}</span>
            </td>
            <td>{{ row.svc.requestCount ?? 0 }}</td>
            <td :title="row.svc.lastStartDurationMs ? '最近一次冷启动耗时' : ''">{{ row.svc.lastStartDurationMs ? formatMs(row.svc.lastStartDurationMs) : '-' }}</td>
            <td>{{ row.svc.activeConnections }}</td>
            <td class="ops-cell">
              <!-- 启动/停止合二为一：按状态切换文案与样式 -->
              <button
                v-if="row.svc.status !== 'online'"
                class="btn btn-start"
                :disabled="busy === row.uid || !!row.svc.paused"
                @click="onStart(row)"
              >启动</button>
              <button
                v-else
                class="btn btn-stop"
                title="停止进程，下次请求到达会自动按需拉起"
                :disabled="busy === row.uid"
                @click="onStop(row)"
              >停止</button>
              <button
                v-if="!row.svc.paused"
                class="btn btn-danger"
                :disabled="busy === row.uid"
                title="停止并禁止按需拉起，需手动解除"
                @click="onDisable(row)"
              >彻底关停</button>
              <button
                v-else
                class="btn"
                :disabled="busy === row.uid"
                @click="onEnable(row)"
              >解除关停</button>
            </td>
          </tr>
          <tr v-if="expanded.has(row.uid) && details.get(row.uid)">
            <td colspan="8" class="detail-cell">
              <StatsCharts v-if="statsMap.get(row.uid)" :stats="statsMap.get(row.uid)!" />
              <div v-if="details.get(row.uid)" class="detail-grid" :class="{ editing: editingSvc === row.uid }">
                <span>后端地址</span>
                <template v-if="editingSvc === row.uid"><input v-model="editForm.base" placeholder="http://127.0.0.1:41001" /></template>
                <code v-else>{{ details.get(row.uid)!.base }}</code>
                <span>代理端口</span>
                <code v-if="row.svc.socks">🧦 socks5 :{{ row.svc.ports?.[0] }}（socks5h://127.0.0.1:{{ row.svc.ports?.[0] }}）</code>
                <code v-else-if="row.svc.ports?.length">:{{ row.svc.ports[0] }}</code>
                <code v-else>-</code>
                <span>健康检查</span>
                <template v-if="editingSvc === row.uid">
                  <select v-model="editForm.healthType">
                    <option value="">（默认 tcp）</option>
                    <option value="tcp">tcp</option>
                    <option value="http">http</option>
                    <option value="command">command</option>
                  </select>
                </template>
                <code v-else>{{ details.get(row.uid)!.healthCheck?.type ?? '-' }}</code>
                <span>模式</span>
                <code>
                  <template v-if="details.get(row.uid)!.proxyOnly">纯代理</template>
                  <template v-if="details.get(row.uid)!.netns">netns 隔离</template>
                  <template v-if="details.get(row.uid)!.keepWarm">keepWarm</template>
                  <template v-if="!details.get(row.uid)!.proxyOnly && !details.get(row.uid)!.netns">常规</template>
                </code>
                <span>启动次数</span><code>{{ details.get(row.uid)!.startCount }}</code>
                <span>最后访问</span><code>{{ formatTime(details.get(row.uid)!.lastAccessTime) }}</code>
                <span>闲置回收</span>
                <template v-if="editingSvc === row.uid"><div class="inline-field"><input v-model.number="editForm.idleSec" type="number" min="0" /><small class="hint">秒</small></div></template>
                <code v-else>{{ formatDuration(details.get(row.uid)!.idleTimeout) }}</code>
                <span>启动超时</span>
                <template v-if="editingSvc === row.uid"><div class="inline-field"><input v-model.number="editForm.startSec" type="number" min="1" /><small class="hint">秒</small></div></template>
                <code v-else>{{ formatDuration(details.get(row.uid)!.startTimeout ?? 0) }}</code>
                <span>启动命令</span>
                <template v-if="editingSvc === row.uid"><textarea v-model="editForm.startCommand" rows="2"></textarea></template>
                <code v-else class="cmd">{{ details.get(row.uid)!.startCommand || '-' }}</code>
                <span>停止命令</span>
                <template v-if="editingSvc === row.uid"><textarea v-model="editForm.stopCommand" rows="2" placeholder="（默认按 pgid 杀进程组）"></textarea></template>
                <code v-else class="cmd">{{ details.get(row.uid)!.stopCommand || '-' }}</code>
                <template v-if="editingSvc === row.uid">
                  <span></span>
                  <div class="edit-actions">
                    <p v-if="editError" class="error" style="margin: 0; flex: 1">{{ editError }}</p>
                    <button class="btn" :disabled="editSaving" @click="editingSvc = ''">取消</button>
                    <button class="btn btn-start" :disabled="editSaving" @click="saveEdit()">{{ editSaving ? '保存中…' : '保存' }}</button>
                  </div>
                </template>
              </div>
              <div v-if="editingSvc !== row.uid" style="display: flex; justify-content: flex-end; margin-top: 6px">
                <button class="btn" @click="startEdit(row)">{{ row.remote ? `编辑远程配置` : '编辑配置' }}</button>
              </div>
              <p v-if="details.get(row.uid)?.lastStartError" class="error">启动失败：{{ details.get(row.uid)!.lastStartError }}</p>
            </td>
          </tr>
        </template>
        <tr v-for="pe in panelErrors" :key="pe.id">
          <td colspan="8" class="panel-error">⚠️ 远程面板「{{ pe.name }}」拉取失败：{{ pe.error }}</td>
        </tr>
        <tr v-if="!visibleRows.length && !loading">
          <td colspan="8" class="empty">{{ fedRows.length ? '无匹配服务' : '暂无服务' }}</td>
        </tr>
      </tbody>
    </table>

    <!-- 分页栏：筛选/搜索/排序结果集分页浏览（每页 50 行，控制单次 DOM 规模） -->
    <div v-if="totalPages > 1" class="pager">
      <button class="btn" :disabled="pageNo <= 1" @click="gotoPage(pageNo - 1)">上一页</button>
      <span class="pager-info">第 {{ pageNo }} / {{ totalPages }} 页 · 共 {{ sortedRows.length }} 个服务</span>
      <button class="btn" :disabled="pageNo >= totalPages" @click="gotoPage(pageNo + 1)">下一页</button>
      <input
        class="pager-jump"
        type="number"
        min="1"
        :max="totalPages"
        :model-value="pageNo"
        @change="gotoPage(Number(($event.target as HTMLInputElement).value) || 1)"
        title="跳转到指定页"
      />
      <select v-model.number="pageSize" class="panel-select" title="每页行数">
        <option v-for="n in PAGE_SIZE_OPTIONS" :key="n" :value="n">{{ n }} 条/页</option>
      </select>
    </div>

    <GlobalChart :services="globalSeries" />
  </div>
  <AppDialog />
</template>
