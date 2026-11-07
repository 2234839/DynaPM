<script setup lang="ts">
/** 远程面板管理对话框：增删改 + 连通性测试，保存后通知父组件重新聚合 */
import { ref } from 'vue';
import {
  loadPanels,
  savePanels,
  newPanelId,
  normalizeBaseUrl,
  PanelClient,
  type RemotePanel,
} from '../panels';

const emit = defineEmits<{ close: []; saved: [] }>();

/** 面板列表（编辑中的副本，确认保存时写回 localStorage） */
const panels = ref<RemotePanel[]>(loadPanels().map((p) => ({ ...p })));
/** 正在编辑的面板 id（空串 = 新增表单行） */
const editingId = ref('');
/** 编辑表单 */
const form = ref({ name: '', baseUrl: '', token: '' });
/** 表单/测试错误信息 */
const msg = ref('');
const msgOk = ref(false);

/** 进入编辑（或新增：id 置空） */
function startEdit(p?: RemotePanel): void {
  msg.value = '';
  editingId.value = p?.id ?? '';
  form.value = p ? { name: p.name, baseUrl: p.baseUrl, token: p.token } : { name: '', baseUrl: '', token: '' };
}

/** 保存编辑行：校验 baseUrl 格式与必填项 */
function saveEdit(): void {
  msg.value = '';
  const base = normalizeBaseUrl(form.value.baseUrl);
  if (!form.value.name.trim() || !base || !form.value.token.trim()) {
    msg.value = '名称、地址（http/https:// 开头）、令牌均为必填';
    return;
  }
  if (editingId.value) {
    const p = panels.value.find((x) => x.id === editingId.value);
    if (p) Object.assign(p, { name: form.value.name.trim(), baseUrl: base, token: form.value.token.trim() });
  } else {
    panels.value.push({
      id: newPanelId(),
      name: form.value.name.trim(),
      baseUrl: base,
      token: form.value.token.trim(),
    });
  }
  persist();
  editingId.value = '';
}

/** 删除面板（二次确认） */
async function remove(p: RemotePanel): Promise<void> {
  const { confirmDialog } = await import('../composables/dialog');
  if (!(await confirmDialog(`移除面板「${p.name}」？（仅移除本地面板的接入配置，不影响对方服务器）`, { danger: true, okText: '移除' }))) return;
  panels.value = panels.value.filter((x) => x.id !== p.id);
  persist();
}

/** 测试连通性 */
async function test(p: RemotePanel): Promise<void> {
  msg.value = '测试中…';
  msgOk.value = false;
  const r = await new PanelClient(p).test();
  msg.value = `[${p.name}] ${r.message}`;
  msgOk.value = r.ok;
}

/** 写回 localStorage 并通知父组件 */
function persist(): void {
  savePanels(panels.value);
  emit('saved');
}
</script>

<template>
  <div class="dlg-mask" @click.self="emit('close')">
    <div class="dlg-box panel-manager">
      <h3>远程面板接入</h3>
      <p class="hint">接入后可在本面板统一查看/启停对方网关的服务。跨域需对方在 <code>adminApi.corsOrigins</code> 中加入本面板地址。</p>

      <table class="pm-table">
        <thead>
          <tr><th>名称</th><th>地址</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="p in panels" :key="p.id">
            <template v-if="editingId === p.id">
              <td><input v-model="form.name" placeholder="显示名" /></td>
              <td><input v-model="form.baseUrl" placeholder="https://dynapm.example.com" /></td>
              <td class="pm-actions">
                <input v-model="form.token" placeholder="管理令牌" class="pm-token" />
                <button class="btn btn-start" @click="saveEdit">保存</button>
                <button class="btn" @click="editingId = ''">取消</button>
              </td>
            </template>
            <template v-else>
              <td>{{ p.name }}</td>
              <td><code>{{ p.baseUrl }}</code></td>
              <td class="pm-actions">
                <button class="btn" @click="test(p)">测试</button>
                <button class="btn" @click="startEdit(p)">编辑</button>
                <button class="btn btn-danger" @click="remove(p)">删除</button>
              </td>
            </template>
          </tr>
          <!-- 新增行：editingId 为空且有表单内容时展示 -->
          <tr v-if="!editingId">
            <td><input v-model="form.name" placeholder="显示名（如：线上服务器）" /></td>
            <td><input v-model="form.baseUrl" placeholder="https://dynapm.example.com" /></td>
            <td class="pm-actions">
              <input v-model="form.token" placeholder="对方管理令牌" class="pm-token" />
              <button class="btn btn-start" :disabled="!form.name.trim() || !form.baseUrl.trim() || !form.token.trim()" @click="saveEdit">添加</button>
            </td>
          </tr>
        </tbody>
      </table>

      <p v-if="msg" class="pm-msg" :class="{ ok: msgOk, err: !msgOk }">{{ msg }}</p>

      <div class="dlg-actions">
        <button class="btn" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel-manager {
  min-width: 720px;
  max-width: 92vw;
  max-height: 86vh;
  overflow: auto;
}
.panel-manager h3 {
  margin: 0 0 8px;
}
.pm-table {
  width: 100%;
  border-collapse: collapse;
  margin: 10px 0;
  font-size: 13px;
}
.pm-table th,
.pm-table td {
  border: 1px solid #e5e7eb;
  padding: 6px 8px;
  text-align: left;
}
.pm-table input {
  width: 100%;
  box-sizing: border-box;
  padding: 4px 6px;
}
.pm-token {
  min-width: 200px;
}
.pm-actions {
  display: flex;
  gap: 6px;
  align-items: center;
  white-space: nowrap;
}
.pm-msg {
  font-size: 13px;
  margin: 6px 0;
  word-break: break-all;
}
.pm-msg.ok {
  color: #15803d;
}
.pm-msg.err {
  color: #dc2626;
}
.hint {
  font-size: 12px;
  color: #6b7280;
  margin: 0 0 6px;
}
</style>
