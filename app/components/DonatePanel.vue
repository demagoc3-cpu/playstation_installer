<script setup lang="ts">
const { t } = useAppLocale()

import { renderSVG } from 'uqr'

const props = defineProps<{ btc: string; usdtTrc20: string }>()
const copied = ref('')
const copyError = ref('')
const activeQr = ref('')
let copiedTimer: ReturnType<typeof setTimeout> | undefined

const wallets = computed(() => [
  { id: 'btc', name: 'Bitcoin (BTC)', symbol: '₿', network: 'Bitcoin', address: props.btc, uri: `bitcoin:${props.btc}`, note: 'Отправляйте только BTC в сети Bitcoin.' },
  { id: 'usdt', name: 'Tether (USDT)', symbol: '₮', network: 'Tron · TRC20', address: props.usdtTrc20, uri: '', note: 'Отправляйте USDT в сети Tron (TRC20).' },
].filter(wallet => wallet.address).map(wallet => ({
  ...wallet,
  qr: renderSVG(wallet.uri || wallet.address, { border: 4, whiteColor: '#ffffff', blackColor: '#101012' }),
})))

/** navigator.clipboard needs a secure context; over plain http on the LAN fall back to execCommand. */
async function copyAddress(id: string, address: string) {
  if (copiedTimer) clearTimeout(copiedTimer)
  copyError.value = ''
  copied.value = ''
  try { await navigator.clipboard.writeText(address) } catch {
    const field = document.createElement('textarea')
    field.value = address
    field.style.position = 'fixed'
    field.style.opacity = '0'
    document.body.appendChild(field)
    field.select()
    try {
      if (!document.execCommand('copy')) { copyError.value = id; return }
    } catch { copyError.value = id; return }
    finally { field.remove() }
  }
  copied.value = id
  copiedTimer = setTimeout(() => { copied.value = '' }, 2000)
}
onBeforeUnmount(() => { if (copiedTimer) clearTimeout(copiedTimer) })
</script>

<template>
  <div class="donate">
    <p class="eyebrow">{{ t("ПОДДЕРЖКА ПРОЕКТА") }}</p>
    <h1>{{ t("Поддержать PackageFlow") }}</h1>
    <p class="donate-lead">{{ t("PackageFlow — бесплатный проект с открытым кодом. Если он вам помогает, можно поддержать его развитие: новые функции, исправления и совместимость с новыми версиями.") }}</p>
    <div v-for="wallet in wallets" :key="wallet.id" class="donate-card" :class="wallet.id">
      <div v-if="activeQr === wallet.id" :id="`donate-qr-${wallet.id}`" class="donate-qr" role="img" :aria-label="t(`QR-код адреса ${wallet.name}, сеть ${wallet.network}`)" v-html="wallet.qr" />
      <div v-else class="donate-wallet-icon" aria-hidden="true">{{ wallet.symbol }}</div>
      <div class="donate-info">
        <span class="donate-coin">{{ wallet.name }}</span>
        <span class="donate-network">{{ t("Сеть:") }} {{ t(wallet.network) }}</span>
        <code class="donate-address">{{ wallet.address }}</code>
        <div class="donate-actions">
          <button class="secondary" :aria-expanded="activeQr === wallet.id" :aria-controls="`donate-qr-${wallet.id}`" :aria-label="`${t(activeQr === wallet.id ? 'Скрыть' : 'Показать')} QR ${wallet.name}`" @click="activeQr = activeQr === wallet.id ? '' : wallet.id">{{ t(activeQr === wallet.id ? 'Скрыть QR' : 'Показать QR') }}</button>
          <button class="primary" @click="copyAddress(wallet.id, wallet.address)">{{ t(copied === wallet.id ? 'Скопировано ✓' : 'Скопировать адрес') }}</button>
          <a v-if="wallet.uri" class="secondary" :href="wallet.uri">{{ t("Открыть в кошельке") }}</a>
        </div>
        <p v-if="copyError === wallet.id" class="donate-copy-error" role="status">{{ t("Не удалось скопировать автоматически. Выделите адрес и скопируйте его вручную.") }}</p>
        <span class="sr-only" role="status">{{ t(copied === wallet.id ? 'Адрес скопирован' : '') }}</span>
        <p class="donate-note">{{ t(wallet.note) }}</p>
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
.donate-wallet-icon { flex: 0 0 112px; width: 112px; height: 112px; display: grid; place-items: center; border-radius: 50%; background: #f7931a; color: white; font: 700 72px/1 Arial, sans-serif; box-shadow: 0 5px 20px #f7931a18; }
.donate-card.usdt .donate-wallet-icon { background: #26a17b; box-shadow: 0 5px 20px #26a17b18; }
.donate-info { min-width: 0; display: flex; flex-direction: column; gap: 14px; }
.donate-coin { color: #e6e1ff; font-size: 14px; font-weight: 800; }
.donate-network { align-self: flex-start; padding: 4px 8px; border-radius: 5px; background: #29272f; color: #bdb5d0; font-size: 11px; }
.donate-address { padding: 10px 12px; overflow-wrap: anywhere; border: 1px solid #3b3941; border-radius: 6px; background: #121216; color: #e9e8ef; font: 12px 'DM Mono', monospace; user-select: all; }
.donate-actions { display: flex; flex-wrap: wrap; gap: 9px; }.donate-actions a { text-decoration: none; display: inline-flex; align-items: center; }
.donate-note { margin: 0; color: #85838b; font-size: 10px; }
.donate-copy-error { margin: 0; color: #e3bd77; font-size: 11px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (max-width: 760px) { .donate-card { flex-direction: column; align-items: stretch; }.donate-qr, .donate-wallet-icon { align-self: center; } }
</style>
