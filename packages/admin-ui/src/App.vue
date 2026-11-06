<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  fetchServices,
  fetchServiceDetail,
  startService,
  stopService,
  disableService,
  enableService,
  captureTokenFromHash,
  getToken,
  clearToken,
  setToken,
  fetchStats,
  type ServiceListItem,
  type ServiceDetail,
  type ServiceStats,
} from './api';
import { fetchConfig, saveConfig } from './api';
import StatsCharts from './StatsCharts.vue';
import GlobalChart from './GlobalChart.vue';
import ConfigEditor from './ConfigEditor.vue';
import AppDialog from './components/AppDialog.vue';
import { confirmDialog } from './composables/dialog';

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
/** 各服务历史统计（图表数据） */
const statsMap = ref<Map<string, ServiceStats>>(new Map());

/** 全局折线图数据：所有服务的分钟请求桶 */
const globalSeries = computed(() =>
  services.value.map((s) => ({
    name: s.name,
    reqBuckets: statsMap.value.get(s.name)?.reqBuckets ?? [],
  })),
);
/** 配置编辑器可见性 */
const configOpen = ref(false);
/** 正在原地编辑配置的服务名（detail-grid 直接切输入态） */
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

/** 进入原地编辑：拉取配置定位该服务条目填充表单 */
async function startEdit(name: string): Promise<void> {
  editError.value = '';
  try {
    const [detail, cfg] = await Promise.all([fetchServiceDetail(name), fetchConfig()]);
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
    editingSvc.value = name;
  } catch (e) {
    editError.value = e instanceof Error ? e.message : String(e);
  }
}

/** 保存原地编辑：改写配置内该服务条目后整体 PUT（服务/超时变更均可热更） */
async function saveEdit(): Promise<void> {
  editError.value = '';
  const f = editForm.value;
  if (!f.base.trim()) {
    editError.value = '后端地址不能为空';
    return;
  }
  editSaving.value = true;
  try {
    const cfg = await fetchConfig();
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
    const res = await saveConfig(cfg);
    if (!res.reloaded) {
      // 含监听地址变更触发网关自重启，等其回来后刷新页面
      editError.value = '保存成功，网关正在重启加载新配置…';
      setTimeout(() => location.reload(), 3000);
      return;
    }
    const name = editingSvc.value;
    editingSvc.value = '';
    await refresh();
    if (name && expanded.value.has(name)) await toggleDetail(name);
  } catch (e) {
    editError.value = e instanceof Error ? e.message : String(e);
  } finally {
    editSaving.value = false;
  }
}

/** 加载服务列表 */
async function refresh(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const data = await fetchServices();
    services.value = data.services ?? [];
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
    authed.value = true;
    tokenInput.value = '';
  } catch (e) {
    clearToken();
    error.value = e instanceof Error && e.message === 'UNAUTHORIZED' ? '令牌无效' : `验证失败: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    loading.value = false;
  }
}

/** 退出登录 */
function logout(): void {
  clearToken();
  authed.value = false;
  services.value = [];
}

/** 展开或收起服务详情 */
async function toggleDetail(name: string): Promise<void> {
  if (expanded.value.has(name)) {
    expanded.value.delete(name);
    expanded.value = new Set(expanded.value);
    return;
  }
  try {
    const detail = await fetchServiceDetail(name);
    details.value.set(name, detail);
    expanded.value = new Set(expanded.value).add(name);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/** 启动服务 */
async function onStart(name: string): Promise<void> {
  busy.value = name;
  try {
    await startService(name);
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = '';
  }
}

/** 停止服务（下次请求会自动按需拉起） */
async function onStop(name: string): Promise<void> {
  busy.value = name;
  try {
    await stopService(name);
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = '';
  }
}

/** 彻底关停（停止并禁止按需拉起） */
async function onDisable(name: string): Promise<void> {
  if (!(await confirmDialog(`彻底关停 ${name}？之后请求到达不会自动拉起，需手动解除。`, { danger: true, okText: '彻底关停' }))) return;
  busy.value = name;
  try {
    await disableService(name);
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = '';
  }
}

/** 解除彻底关停 */
async function onEnable(name: string): Promise<void> {
  busy.value = name;
  try {
    await enableService(name);
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = '';
  }
}

/** 状态徽标样式类 */
function statusClass(status: string): string {
  return `status-${status}`;
}

/** 格式化运行时长（入参毫秒） */
function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
}

/** 启动耗时格式化：秒级显示（冷启动排障用） */
function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** 闲置回收倒计时文案：null（有连接/不回收）显示 -，<1min 显示秒 */
function idleText(svc: ServiceListItem): string {
  const r = svc.idleRemainingMs;
  if (r == null) return '-';
  return r <= 60_000 ? `${Math.ceil(r / 1000)}s 后停` : `${formatUptime(r)} 后停`;
}

/** 倒计时样式：临近回收（<1 分钟）高亮 */
function idleClass(svc: ServiceListItem): string {
  const r = svc.idleRemainingMs;
  return r != null && r <= 60_000 ? 'idle-soon' : 'idle-far';
}

/** 倒计时悬浮提示 */
function idleTitle(svc: ServiceListItem): string {
  const r = svc.idleRemainingMs;
  if (r == null) return '有活跃连接，不回收';
  return `闲置 ${formatUptime(svc.idleTimeout)} 后自动停止，剩余 ${formatUptime(r)}`;
}

/** 拉取历史统计（图表） */
async function refreshStats(): Promise<void> {
  try {
    const data = await fetchStats();
    statsMap.value = new Map((data.services ?? []).map((s) => [s.name, s]));
  } catch {
    // 图表数据拉取失败不打断主列表
  }
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
  const timer = setInterval(refresh, 5000);
  const statsTimer = setInterval(refreshStats, 30_000);
  onUnmounted(() => {
    clearInterval(timer);
    clearInterval(statsTimer);
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
        <button class="btn" @click="logout">退出</button>
      </div>
    </header>

    <ConfigEditor v-if="configOpen" @close="configOpen = false" @saved="onSaved" />

    <p v-if="error" class="error">{{ error }}</p>

    <table class="service-table">
      <thead>
        <tr>
          <th>名称</th>
          <th>状态</th>
          <th>当前存活</th>
          <th>闲置回收</th>
          <th>请求数</th>
          <th>启动耗时</th>
          <th>连接数</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="svc in services" :key="svc.name">
          <tr>
            <td class="name-cell">
              <button class="link arrow" :title="expanded.has(svc.name) ? '收起详情' : '展开详情'" @click="toggleDetail(svc.name)">
                {{ expanded.has(svc.name) ? '▼' : '▶' }}
              </button>
              <a
                v-if="serviceUrl(svc)"
                class="svc-link"
                :href="serviceUrl(svc)!"
                target="_blank"
                rel="noopener"
              >{{ svc.name }}</a>
              <span v-else>{{ svc.name }}</span>
              <span v-if="svc.socks" class="badge port-badge" title="SOCKS5 代理端口">🧦 :{{ svc.ports?.[0] }}</span>
              <span v-else-if="svc.ports?.length" class="badge port-badge" title="专属端口">:{{ svc.ports[0] }}</span>
            </td>
            <td>
              <span class="badge" :class="svc.paused ? 'status-disabled' : statusClass(svc.status)">{{ svc.paused ? 'disabled' : svc.status }}</span>
            </td>
            <td>{{ svc.status === 'online' ? formatUptime(svc.uptime) : '-' }}</td>
            <td>
              <!-- 在线时显示闲置回收倒计时；已停时回退显示历史累计存活 -->
              <span v-if="svc.status === 'online'" :class="idleClass(svc)" :title="idleTitle(svc)">{{ idleText(svc) }}</span>
              <span v-else-if="svc.totalUptime" title="历史累计存活时间">总 {{ formatUptime(svc.totalUptime) }}</span>
              <span v-else>-</span>
            </td>
            <td>{{ svc.requestCount ?? 0 }}</td>
            <td>{{ svc.lastStartDurationMs ? formatMs(svc.lastStartDurationMs) : '-' }}</td>
            <td>{{ svc.activeConnections }}</td>
            <td>
              <!-- 启动/停止合二为一：按状态切换文案与样式 -->
              <button
                v-if="svc.status !== 'online'"
                class="btn btn-start"
                :disabled="busy === svc.name || !!svc.paused"
                @click="onStart(svc.name)"
              >启动</button>
              <button
                v-else
                class="btn btn-stop"
                title="停止进程，下次请求到达会自动按需拉起"
                :disabled="busy === svc.name"
                @click="onStop(svc.name)"
              >停止</button>
              <button
                v-if="!svc.paused"
                class="btn btn-danger"
                :disabled="busy === svc.name"
                title="停止并禁止按需拉起，需手动解除"
                @click="onDisable(svc.name)"
              >彻底关停</button>
              <button
                v-else
                class="btn"
                :disabled="busy === svc.name"
                @click="onEnable(svc.name)"
              >解除关停</button>
            </td>
          </tr>
          <tr v-if="expanded.has(svc.name) && details.get(svc.name)">
            <td colspan="8" class="detail-cell">
              <StatsCharts v-if="statsMap.get(svc.name)" :stats="statsMap.get(svc.name)!" />
              <div v-if="details.get(svc.name)" class="detail-grid" :class="{ editing: editingSvc === svc.name }">
                <span>后端地址</span>
                <template v-if="editingSvc === svc.name"><input v-model="editForm.base" placeholder="http://127.0.0.1:41001" /></template>
                <code v-else>{{ details.get(svc.name)!.base }}</code>
                <span>代理端口</span>
                <code v-if="svc.socks">🧦 socks5 :{{ svc.ports?.[0] }}（socks5h://127.0.0.1:{{ svc.ports?.[0] }}）</code>
                <code v-else-if="svc.ports?.length">:{{ svc.ports[0] }}</code>
                <code v-else>-</code>
                <span>健康检查</span>
                <template v-if="editingSvc === svc.name">
                  <select v-model="editForm.healthType">
                    <option value="">（默认 tcp）</option>
                    <option value="tcp">tcp</option>
                    <option value="http">http</option>
                    <option value="command">command</option>
                  </select>
                </template>
                <code v-else>{{ details.get(svc.name)!.healthCheck?.type ?? '-' }}</code>
                <span>模式</span>
                <code>
                  <template v-if="details.get(svc.name)!.proxyOnly">纯代理</template>
                  <template v-if="details.get(svc.name)!.netns">netns 隔离</template>
                  <template v-if="details.get(svc.name)!.keepWarm">keepWarm</template>
                  <template v-if="!details.get(svc.name)!.proxyOnly && !details.get(svc.name)!.netns">常规</template>
                </code>
                <span>启动次数</span><code>{{ details.get(svc.name)!.startCount }}</code>
                <span>最后访问</span><code>{{ formatTime(details.get(svc.name)!.lastAccessTime) }}</code>
                <span>闲置回收</span>
                <template v-if="editingSvc === svc.name"><div class="inline-field"><input v-model.number="editForm.idleSec" type="number" min="0" /><small class="hint">秒</small></div></template>
                <code v-else>{{ formatUptime(details.get(svc.name)!.idleTimeout) }}</code>
                <span>启动超时</span>
                <template v-if="editingSvc === svc.name"><div class="inline-field"><input v-model.number="editForm.startSec" type="number" min="1" /><small class="hint">秒</small></div></template>
                <code v-else>{{ formatUptime(details.get(svc.name)!.startTimeout ?? 0) }}</code>
                <span>启动命令</span>
                <template v-if="editingSvc === svc.name"><textarea v-model="editForm.startCommand" rows="2"></textarea></template>
                <code v-else class="cmd">{{ details.get(svc.name)!.startCommand || '-' }}</code>
                <span>停止命令</span>
                <template v-if="editingSvc === svc.name"><textarea v-model="editForm.stopCommand" rows="2" placeholder="（默认按 pgid 杀进程组）"></textarea></template>
                <code v-else class="cmd">{{ details.get(svc.name)!.stopCommand || '-' }}</code>
                <template v-if="editingSvc === svc.name">
                  <span></span>
                  <div class="edit-actions">
                    <p v-if="editError" class="error" style="margin: 0; flex: 1">{{ editError }}</p>
                    <button class="btn" :disabled="editSaving" @click="editingSvc = ''">取消</button>
                    <button class="btn btn-start" :disabled="editSaving" @click="saveEdit()">{{ editSaving ? '保存中…' : '保存' }}</button>
                  </div>
                </template>
              </div>
              <div v-if="editingSvc !== svc.name" style="display: flex; justify-content: flex-end; margin-top: 6px">
                <button class="btn" @click="startEdit(svc.name)">编辑配置</button>
              </div>
              <p v-if="details.get(svc.name)?.lastStartError" class="error">启动失败：{{ details.get(svc.name)!.lastStartError }}</p>
            </td>
          </tr>
        </template>
        <tr v-if="!services.length && !loading">
          <td colspan="8" class="empty">暂无服务</td>
        </tr>
      </tbody>
    </table>

    <GlobalChart :services="globalSeries" />
  </div>
  <AppDialog />
</template>
