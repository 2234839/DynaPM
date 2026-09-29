<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import {
  fetchServices,
  fetchServiceDetail,
  startService,
  stopService,
  type ServiceListItem,
  type ServiceDetail,
} from './api';

/** 服务列表 */
const services = ref<ServiceListItem[]>([]);
/** 展开详情的服务名 -> 详情 */
const details = ref<Map<string, ServiceDetail>>(new Map());
const loading = ref(false);
const error = ref('');
/** 操作中的服务名（按钮禁用） */
const busy = ref('');
const expanded = ref<Set<string>>(new Set());

/** 加载服务列表 */
async function refresh(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const data = await fetchServices();
    services.value = data.services ?? [];
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
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

/** 停止服务 */
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

/** 状态徽标样式类 */
function statusClass(status: string): string {
  return `status-${status}`;
}

/** 格式化运行时长 */
function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

onMounted(() => {
  refresh();
  const timer = setInterval(refresh, 5000);
  onUnmounted(() => clearInterval(timer));
});
</script>

<template>
  <div class="container">
    <header class="header">
      <h1>ModelRep 管理界面</h1>
      <button class="btn" :disabled="loading" @click="refresh">
        {{ loading ? '刷新中…' : '手动刷新' }}
      </button>
    </header>

    <p v-if="error" class="error">{{ error }}</p>

    <table class="service-table">
      <thead>
        <tr>
          <th>名称</th>
          <th>Base</th>
          <th>状态</th>
          <th>运行时长</th>
          <th>连接数</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="svc in services" :key="svc.name">
          <tr>
            <td>
              <button class="link" @click="toggleDetail(svc.name)">
                {{ expanded.has(svc.name) ? '▼' : '▶' }} {{ svc.name }}
              </button>
            </td>
            <td class="mono">{{ svc.base }}</td>
            <td><span class="badge" :class="statusClass(svc.status)">{{ svc.status }}</span></td>
            <td>{{ svc.status === 'running' ? formatUptime(svc.uptime) : '-' }}</td>
            <td>{{ svc.activeConnections }}</td>
            <td>
              <button
                class="btn"
                :disabled="busy === svc.name"
                @click="onStart(svc.name)"
              >启动</button>
              <button
                class="btn btn-danger"
                :disabled="busy === svc.name || svc.status !== 'running'"
                @click="onStop(svc.name)"
              >停止</button>
            </td>
          </tr>
          <tr v-if="expanded.has(svc.name) && details.get(svc.name)">
            <td colspan="6" class="detail-cell">
              <pre class="detail">{{ JSON.stringify(details.get(svc.name), null, 2) }}</pre>
            </td>
          </tr>
        </template>
        <tr v-if="!services.length && !loading">
          <td colspan="6" class="empty">暂无服务</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
