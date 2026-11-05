<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { current, inputValue, cancel, ok } from '../composables/dialog';

/** Escape 触发取消（输入框内 Enter 触发确认） */
function onKey(e: KeyboardEvent): void {
  if (!current.value) return;
  if (e.key === 'Escape') cancel();
  if (e.key === 'Enter' && current.value.input) ok();
}
onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div v-if="current" class="dlg-mask" @click.self="cancel">
    <div class="dlg-box">
      <p class="dlg-msg">{{ current.message }}</p>
      <input
        v-if="current.input"
        v-model="inputValue"
        class="dlg-input"
        type="text"
        autofocus
        spellcheck="false"
      />
      <div class="dlg-actions">
        <button class="btn" @click="cancel">取消</button>
        <button class="btn" :class="current.danger ? 'btn-danger' : 'btn-primary'" @click="ok">
          {{ current.okText ?? '确定' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dlg-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.dlg-box {
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.18);
  padding: 20px;
  min-width: 320px;
  max-width: 440px;
}
.dlg-msg {
  margin: 0 0 14px;
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
}
.dlg-input {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 10px;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  font-size: 13px;
  margin-bottom: 14px;
}
.dlg-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.dlg-actions .btn {
  padding: 5px 16px;
  cursor: pointer;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  background: #fff;
  font-size: 13px;
}
.btn-primary {
  background: #1f6feb !important;
  border-color: #1f6feb !important;
  color: #fff !important;
}
</style>
