<script setup lang="ts">
const { t } = useAppLocale()
defineProps<{ title: string; titleId: string; cover?: string; count: number; total?: number; open: boolean }>()
const emit = defineEmits<{ toggle: [] }>()
</script>
<template><article class="pf-game-branch"><div class="pf-game-head"><button class="pf-expand" :aria-expanded="open" :aria-label="t(`Пакеты: ${title}`)" @click="emit('toggle')"><span :class="{ open }">›</span></button><div class="pf-game-cover"><img v-if="cover" :src="cover" alt="" loading="lazy" decoding="async"><span v-else>{{ title.charAt(0) }}</span></div><button class="pf-game-name" @click="emit('toggle')"><strong>{{ title }}</strong><span>{{ titleId }} · {{ count }}<template v-if="total && total > count"> {{ t('из') }} {{ total }}</template> {{ t('пак.') }}</span><slot name="summary" /></button><div class="pf-group-actions"><slot name="actions" /></div></div><div v-if="open" class="pf-package-list"><slot /></div></article></template>
<style scoped>
.pf-game-branch{border-bottom:1px solid #29282e}.pf-game-head{display:grid;grid-template-columns:26px 32px minmax(180px,1fr) auto;align-items:center;gap:9px;padding:7px 12px;background:#1e1d22}.pf-expand{width:26px;height:26px;padding:0;color:#aaa3cf;border:0;background:transparent;font-size:22px}.pf-expand span{display:inline-block;transform:rotate(0deg)}.pf-expand .open{transform:rotate(90deg)}.pf-game-cover{width:32px;height:40px;overflow:hidden;display:grid;place-items:center;background:#35343c;border-radius:5px;color:#eeeafe;font:700 19px Georgia,serif}.pf-game-cover img{width:100%;height:100%;object-fit:cover}.pf-game-name{min-width:0;padding:0;text-align:left;border:0;color:inherit;background:transparent}.pf-game-name strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.pf-game-name span{display:block;margin-top:3px;color:#85828a;font:10px 'DM Mono',monospace}.pf-group-actions{display:flex;align-items:center;justify-content:flex-end;gap:7px;white-space:nowrap}.pf-package-list{background:#19191c}
/* The library's notification typography is shared by every game tree. */
.pf-game-name :deep(.group-current),.pf-game-name :deep(.group-pending),.pf-game-name :deep(.group-skipped){display:block;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;font:10px 'DM Mono',monospace}
.pf-game-name :deep(.group-current){color:#b9aafa;font-weight:700}
.pf-game-name :deep(.group-pending){color:#a5a2ae}
.pf-game-name :deep(.group-skipped){color:#e3bd77}
</style>
