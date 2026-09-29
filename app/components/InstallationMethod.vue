<script setup lang="ts">
import type { InstallationTransport } from '../../shared/types/installation'
const props = defineProps<{ ip: string; modelValue: InstallationTransport; disabled: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: InstallationTransport]; status: [ready: boolean] }>()
const key = ref('')
const showKey = ref(false)
const busy = ref(false)
const message = ref('')
const configured = ref(false)
let checkId = 0
async function check() {
  const id = ++checkId; const ip = props.ip
  busy.value = true
  try {
    const result = await $fetch<{ ready: boolean; configured: boolean; message: string }>('/api/ps4/service-installer', { query: { ip } })
    if (id !== checkId || ip !== props.ip) return
    configured.value = result.configured; message.value = result.message
    emit('status', result.ready)
    if (!result.configured) showKey.value = true
  } catch (error: any) {
    if (id === checkId) { message.value = error?.data?.message || 'Не удалось проверить сервис'; emit('status', false) }
  } finally { if (id === checkId) busy.value = false }
}
async function saveKey() {
  const ip = props.ip; busy.value = true
  try {
    const result = await $fetch<{ message: string }>('/api/ps4/service-key', { method: 'POST', body: { ip, code: key.value } })
    if (ip !== props.ip) return
    key.value = ''; configured.value = true; showKey.value = false; message.value = result.message
    emit('status', true)
  } catch (error: any) { message.value = error?.data?.message || 'Не удалось подключить PS4' }
  finally { busy.value = false }
}
watch(() => [props.ip, props.modelValue], () => {
  key.value = ''; message.value = ''; configured.value = false; showKey.value = false
  emit('status', false)
  if (props.modelValue === 'service') void check()
})
function inputCode(value: string) {
  const symbols = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
  key.value = symbols.length > 3 ? `${symbols.slice(0, 3)}-${symbols.slice(3)}` : symbols
}
</script>

<template>
  <section class="installation-method" aria-label="Способ установки">
    <div class="method-row">
      <label>Способ установки
        <select :value="modelValue" :disabled="disabled" @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value as InstallationTransport)">
          <option value="payload">PyLoader — по умолчанию</option>
          <option value="service">PackegeFlowService</option>
        </select>
      </label>
      <template v-if="modelValue === 'service'">
        <button :disabled="busy || disabled" @click="check">{{ busy ? 'Проверяем…' : 'Проверить сервис' }}</button>
        <button v-if="configured" :disabled="busy || disabled" @click="showKey = !showKey">Повторить сопряжение</button>
      </template>
    </div>
    <p v-if="modelValue === 'payload'">Игры, патчи и DLC через текущий загрузчик. Автоустановка торрентов всегда использует PyLoader.</p>
    <template v-else>
      <p>Первое испытание: базовая игра через PKG 1.17. Патчи и DLC пока устанавливаются через PyLoader.</p>
      <p v-if="message" role="status">{{ message }}</p>
      <form v-if="showKey" @submit.prevent="saveKey">
        <label>Код с экрана запускателя PS4
          <input :value="key" @input="inputCode(($event.target as HTMLInputElement).value)" type="text" maxlength="7" autocomplete="off" autocapitalize="characters" spellcheck="false" :disabled="busy || disabled" placeholder="F7Y-YUH">
        </label>
        <button :disabled="busy || disabled || !/^[a-z0-9]{3}-[a-z0-9]{3}$/i.test(key.trim())">Подключить</button>
        <small>Введите один раз в течение 5 минут. WEB сохранит подключение. Для нового кода откройте запускатель PS4 ещё раз.</small>
      </form>
    </template>
  </section>
</template>

<style scoped>
.installation-method { margin: 18px 0; padding: 18px 22px; background: #1b1a1f; border: 1px solid #2d2c33; border-radius: 10px; }
.method-row, form { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; }
label { display: flex; flex-direction: column; gap: 7px; color: #c9c5d3; font-size: 12px; }
select, input { min-width: 250px; padding: 10px; background: #242229; border: 1px solid #45414e; border-radius: 6px; color: #eee9ff; }
button { padding: 10px 13px; background: #403752; color: #f3edff; border: 1px solid #57476e; border-radius: 6px; cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
p, small { color: #a9a6b2; font-size: 12px; line-height: 1.6; }
small { width: 100%; }
</style>
