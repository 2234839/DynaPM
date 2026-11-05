<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { fetchConfig, saveConfig } from './api';
import { confirmDialog, promptDialog } from './composables/dialog';

/** 编辑模式 */
const mode = ref<'visual' | 'json'>('visual');
/** 原始配置对象（保留所有字段，表单只覆盖展示的字段） */
let raw: Record<string, any> = {};
/** 可视化表单态：直接引用 raw 内对象实现未知字段保留 */
const form = reactive({
  host: '',
  port: 0,
  adminHost: '',
  services: {} as Record<string, any>,
});
/** JSON 文本态 */
const jsonText = ref('');
const busy = ref(false);
const msg = ref('');
/** 加载时配置文件的 mtime（保存时携带做冲突检测） */
const loadedMtime = ref(0);
/** 编辑期间磁盘文件被外部修改 */
const externalChange = ref(false);
/** 服务 key 列表（map 保序展示） */
const allServiceKeys = computed(() => Object.keys(form.services));
/** 搜索关键字（空格分词，name/host/base 命中即保留） */
const search = ref('');
/** 过滤后的服务 key */
const serviceKeys = computed(() => {
  const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return allServiceKeys.value;
  return allServiceKeys.value.filter((k) => {
    const s = form.services[k] ?? {};
    const hay = `${k} ${s.name ?? ''} ${s.host ?? ''} ${s.base ?? ''}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
});
/** 健康检查类型选项 */
const hcTypes = ['tcp', 'http', 'command', 'none'];

/** 毫秒 → 友好时长（如 10m、1m30s、2h5m） */
function fmtMs(ms?: number): string {
  if (!ms || ms <= 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
}

/** 从 raw 配置对象填充表单 */
function loadForm(cfg: Record<string, any>): void {
  raw = cfg;
  loadedMtime.value = cfg._mtime ?? 0;
  delete cfg._mtime;
  form.host = cfg.host ?? '';
  form.port = cfg.port ?? 0;
  form.adminHost = cfg.adminApi?.host ?? '';
  form.services = cfg.services ?? {};
}

/** 拉取配置 */
async function reload(): Promise<void> {
  busy.value = true;
  msg.value = '';
  externalChange.value = false;
  try {
    loadForm(await fetchConfig());
    syncJson();
  } catch (e) {
    msg.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

/** 表单 → JSON 文本（不修改 raw 对象，顶层浅覆盖） */
function syncJson(): void {
  const out: Record<string, any> = { ...raw, host: form.host, port: form.port };
  delete out._mtime;
  out.adminApi = { ...(raw.adminApi ?? {}), host: form.adminHost || undefined };
  out.services = { ...form.services };
  jsonText.value = JSON.stringify(out, null, 2);
}

/** JSON 文本 → 表单（切换回可视化时同步） */
function syncForm(): boolean {
  try {
    loadForm(JSON.parse(jsonText.value));
    return true;
  } catch (e) {
    msg.value = `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`;
    return false;
  }
}

/** 切换模式：双向同步 */
function switchMode(m: 'visual' | 'json'): void {
  if (m === mode.value) return;
  if (m === 'json') {
    syncJson();
  } else if (!syncForm()) {
    return; // JSON 非法时拒绝切回可视化
  }
  mode.value = m;
  msg.value = '';
}

/** 保存：以当前模式的内容为准，确认后提交（网关自重启生效） */
async function save(): Promise<void> {
  const content = mode.value === 'json' ? jsonText.value : (syncJson(), jsonText.value);
  if (mode.value === 'json' && !syncForm()) return; // 校验 JSON 可解析
  if (externalChange.value
    && !(await confirmDialog('磁盘配置已被外部修改，继续保存将覆盖外部改动。确定覆盖？', { danger: true, okText: '覆盖保存' }))) {
    return;
  }
  if (!(await confirmDialog('保存并重启网关生效？重启期间服务短暂不可用（约 1 秒）。', { okText: '保存并重启' }))) return;
  busy.value = true;
  msg.value = '';
  try {
    // 携带加载时 mtime：期间磁盘被外部改过则后端返回 409，提示重新加载
    const body = { ...JSON.parse(jsonText.value), _mtime: loadedMtime.value };
    await saveConfig(body);
    msg.value = '✅ 已保存，网关重启中… 几秒后可手动刷新';
  } catch (e) {
    msg.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

/** 新增服务（生成默认骨架） */
async function addService(): Promise<void> {
  const name = (await promptDialog('服务名（同时作为 services key 与 hostname 路由前缀）'))?.trim();
  if (!name || form.services[name]) return;
  form.services[name] = {
    name,
    base: 'http://127.0.0.1:8080',
    host: `${name}.example.com`,
    idleTimeout: 300000,
    startTimeout: 30000,
    netns: true,
    commands: { start: '', stop: '' },
    healthCheck: { type: 'tcp' },
  };
}

/** 删除服务 */
async function removeService(key: string): Promise<void> {
  if (!(await confirmDialog(`删除服务 ${key}？`, { danger: true, okText: '删除' }))) return;
  delete form.services[key];
}

/** 重命名服务 key（迁移对象保持顺序末尾） */
async function renameService(oldKey: string): Promise<void> {
  const name = (await promptDialog('新服务名', oldKey))?.trim();
  if (!name || name === oldKey || form.services[name]) return;
  const entry = form.services[oldKey];
  delete form.services[oldKey];
  entry.name = name;
  form.services[name] = entry;
}

const emit = defineEmits<{ saved: []; close: [] }>();
/** 保存成功后通知父组件刷新（含重启延迟） */
watch(msg, (v) => {
  if (v.startsWith('✅')) {
    emit('saved');
  }
});

reload();

/** 编辑期间每 10s 比对磁盘 mtime，外部修改时提示（不自动覆盖编辑器内容） */
let pollTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  pollTimer = setInterval(async () => {
    if (busy.value) return;
    try {
      const c = await fetchConfig();
      if ((c._mtime ?? 0) !== loadedMtime.value) externalChange.value = true;
    } catch {
      // 网关重启中拉不到属正常，忽略
    }
  }, 10_000);
});
onUnmounted(() => clearInterval(pollTimer));
</script>

<template>
  <div class="config-box">
    <div class="config-head">
      <b>网关配置</b>
      <div class="mode-tabs">
        <button class="btn" :class="{ 'tab-active': mode === 'visual' }" @click="switchMode('visual')">可视化</button>
        <button class="btn" :class="{ 'tab-active': mode === 'json' }" @click="switchMode('json')">JSON</button>
      </div>
      <span class="config-hint">保存后网关自重启生效；authToken 显示为 *** 时保持不变</span>
      <div>
        <button class="btn" :disabled="busy" @click="reload">重新加载</button>
        <button class="btn btn-danger" :disabled="busy" @click="save">保存并重启</button>
        <button class="btn" @click="emit('close')">关闭</button>
      </div>
    </div>

    <p v-if="externalChange" class="external-warn">⚠️ 磁盘配置文件已被外部修改（如 ssh 直接编辑），重新加载可获取最新内容，直接保存将覆盖外部改动</p>

    <!-- 可视化模式 -->
    <div v-if="mode === 'visual'">
      <div class="form-grid">
        <label>监听地址 <input v-model="form.host" class="cfg-input" placeholder="127.0.0.1" /></label>
        <label>监听端口 <input v-model.number="form.port" class="cfg-input" type="number" /></label>
        <label>面板域名 <input v-model="form.adminHost" class="cfg-input" placeholder="dynapm.example.com" /></label>
      </div>

      <div class="svc-list-head">
        <b>服务（{{ serviceKeys.length }}/{{ allServiceKeys.length }}）</b>
        <input
          v-model="search"
          class="cfg-input svc-search"
          placeholder="搜索：名称 / 域名 / 后端地址（空格分词）"
        />
        <button class="btn" @click="addService">+ 添加服务</button>
      </div>

      <p v-if="serviceKeys.length && serviceKeys.length < allServiceKeys.length" class="search-note">
        已过滤，仅显示命中的 {{ serviceKeys.length }} 个服务
      </p>

      <div v-for="key in serviceKeys" :key="key" class="svc-card">
        <div class="svc-card-head">
          <b>{{ key }}</b>
          <div>
            <button class="btn" @click="renameService(key)">重命名</button>
            <button class="btn btn-danger" @click="removeService(key)">删除</button>
          </div>
        </div>
        <div class="form-grid">
          <label>域名 <input v-model="form.services[key].host" class="cfg-input" /></label>
          <label>后端地址 <input v-model="form.services[key].base" class="cfg-input" /></label>
          <label>闲置回收(ms) <span v-if="fmtMs(form.services[key].idleTimeout)" class="ms-hint">≈ {{ fmtMs(form.services[key].idleTimeout) }}</span> <input v-model.number="form.services[key].idleTimeout" class="cfg-input" type="number" /></label>
          <label>启动超时(ms) <span v-if="fmtMs(form.services[key].startTimeout)" class="ms-hint">≈ {{ fmtMs(form.services[key].startTimeout) }}</span> <input v-model.number="form.services[key].startTimeout" class="cfg-input" type="number" /></label>
          <label>健康检查
            <select v-model="form.services[key].healthCheck.type" class="cfg-input">
              <option v-for="t in hcTypes" :key="t" :value="t">{{ t }}</option>
            </select>
          </label>
        </div>
        <div class="form-flags">
          <label><input type="checkbox" v-model="form.services[key].netns" /> netns 隔离</label>
          <label><input type="checkbox" v-model="form.services[key].keepWarm" /> keepWarm</label>
          <label><input type="checkbox" v-model="form.services[key].proxyOnly" /> 纯代理</label>
          <label><input type="checkbox" v-model="form.services[key].adminPanel" /> 允许面板</label>
          <label><input type="checkbox" v-model="form.services[key].passthrough" /> TCP 直通</label>
        </div>
        <div class="form-cmds">
          <label>启动命令 <textarea v-model="form.services[key].commands.start" class="cfg-input cfg-textarea" rows="2" spellcheck="false" /></label>
          <label>停止命令 <input v-model="form.services[key].commands.stop" class="cfg-input" spellcheck="false" /></label>
        </div>
      </div>
      <p v-if="!serviceKeys.length" class="empty">暂无服务，点击「添加服务」</p>
    </div>

    <!-- JSON 模式 -->
    <textarea v-else v-model="jsonText" class="config-editor" spellcheck="false" :disabled="busy" />

    <p v-if="msg" class="config-msg">{{ msg }}</p>
  </div>
</template>

<style scoped>
/* 毫秒输入旁的友好时长提示 */
.ms-hint { color: #0969da; font-weight: 600; }
.mode-tabs {
  display: inline-flex;
  gap: 0;
}
.mode-tabs .btn {
  margin-right: -1px;
  border-radius: 0;
}
.mode-tabs .btn:first-child {
  border-radius: 6px 0 0 6px;
}
.mode-tabs .btn:last-child {
  border-radius: 0 6px 6px 0;
  margin-right: 6px;
}
.tab-active {
  background: #0969da;
  color: #fff;
  border-color: #0969da;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 10px;
  margin-bottom: 10px;
}
.form-grid label,
.form-cmds label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #57606a;
}
.cfg-input {
  padding: 5px 8px;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
  width: 100%;
  box-sizing: border-box;
}
.cfg-textarea {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  resize: vertical;
}
.form-flags {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 12px;
  color: #57606a;
  margin-bottom: 10px;
}
.form-flags label {
  display: flex;
  align-items: center;
  gap: 4px;
}
.form-cmds {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 10px;
}
.svc-list-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 8px 0;
  font-size: 13px;
  gap: 10px;
}
.svc-list-head .svc-search {
  width: 260px;
  flex: 0 1 auto;
  margin-left: auto;
}
.search-note {
  font-size: 12px;
  color: #8b949e;
  margin: 0 0 8px;
}
.svc-card {
  border: 1px solid #d0d7de;
  border-radius: 6px;
  padding: 10px 12px;
  margin-bottom: 10px;
  background: #fafbfc;
}
.svc-card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  font-size: 13px;
}
.config-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.config-head > div:last-child {
  margin-left: auto;
}
.config-hint {
  font-size: 12px;
  color: #57606a;
}
.config-msg {
  font-size: 13px;
  color: #0969da;
  margin: 8px 0 0;
}
.external-warn {
  font-size: 13px;
  color: #9a6700;
  background: #fff8c5;
  border: 1px solid #d4a72c66;
  border-radius: 6px;
  padding: 6px 10px;
  margin: 0 0 10px;
}
.empty {
  color: #8b949e;
  font-size: 13px;
  text-align: center;
  padding: 12px;
}
</style>
