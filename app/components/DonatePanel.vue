<script setup lang="ts">
import { renderSVG } from 'uqr'

const props = defineProps<{ btc: string }>()
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

const qr = computed(() => props.btc ? renderSVG(`bitcoin:${props.btc}`, { border: 1, whiteColor: '#ffffff', blackColor: '#101012' }) : '')

/** navigator.clipboard needs a secure context; over plain http on the LAN fall back to execCommand. */
async function copyAddress() {
  try { await navigator.clipboard.writeText(props.btc) } catch {
    const field = document.createElement('textarea')
    field.value = props.btc
    field.style.position = 'fixed'
    field.style.opacity = '0'
    document.body.appendChild(field)
    field.select()
    document.execCommand('copy')
    field.remove()
  }
  copied.value = true
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copied.value = false }, 2000)
}
</script>

<template>
  <div class="donate">
    <p class="eyebrow">ПОДДЕРЖКА ПРОЕКТА</p>
    <h1>Поддержать PackageFlow</h1>
    <p class="donate-lead">PackageFlow — бесплатный проект с открытым кодом. Если он вам помогает, можно поддержать его развитие: новые функции, исправления и совместимость с новыми версиями.</p>
    <div class="donate-card">
      <div class="donate-qr" v-html="qr" />
      <div class="donate-info">
        <span class="donate-coin"><b>₿</b> Bitcoin (BTC)</span>
        <code class="donate-address">{{ btc }}</code>
        <div class="donate-actions">
          <button class="primary" @click="copyAddress">{{ copied ? 'Скопировано ✓' : 'Скопировать адрес' }}</button>
          <a class="secondary" :href="`bitcoin:${btc}`">Открыть в кошельке</a>
        </div>
        <p class="donate-note">Отправляйте только BTC в сети Bitcoin. Монеты других сетей на этот адрес будут потеряны.</p>
      </div>
    </div>
  </div>
</template>

<style>
.donate h1 { margin: 0 0 10px; font-size: 30px; }
.donate-lead { max-width: 680px; color: #a9a6b2; font-size: 13px; line-height: 1.7; }
.donate-card { max-width: 800px; margin-top: 24px; padding: 24px; display: flex; gap: 28px; align-items: center; border: 1px solid #2d2c33; border-radius: 10px; background: #1b1a1f; }
.donate-qr { flex: 0 0 180px; width: 180px; height: 180px; padding: 8px; border-radius: 8px; background: #ffffff; }
.donate-qr svg { display: block; width: 100%; height: 100%; }
.donate-info { min-width: 0; display: flex; flex-direction: column; gap: 14px; }
.donate-coin { color: #e6e1ff; font-size: 14px; font-weight: 800; }.donate-coin b { color: #f2a33a; }
.donate-address { padding: 10px 12px; overflow-wrap: anywhere; border: 1px solid #3b3941; border-radius: 6px; background: #121216; color: #e9e8ef; font: 12px 'DM Mono', monospace; user-select: all; }
.donate-actions { display: flex; flex-wrap: wrap; gap: 9px; }.donate-actions a { text-decoration: none; display: inline-flex; align-items: center; }
.donate-note { margin: 0; color: #85838b; font-size: 10px; }
@media (max-width: 760px) { .donate-card { flex-direction: column; align-items: stretch; }.donate-qr { align-self: center; } }
</style>
