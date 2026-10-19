<script setup>
import {computed} from 'vue';
const props=defineProps({device:Object,update:Object,en:Boolean,compact:Boolean});
const t=(ru,en)=>props.en?en:ru;
const unknown=()=>t('Не проверено','Not checked');
const value=v=>v===undefined||v===null||v===''?unknown():String(v);
const bytes=v=>Number.isFinite(v)&&v>=0?`${(v/1024**3).toLocaleString(props.en?'en-US':'ru-RU',{maximumFractionDigits:1})} GiB`:unknown();
const time=v=>Number.isFinite(v)?new Date(v).toLocaleString(props.en?'en-GB':'ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):unknown();
const used=computed(()=>props.device.totalBytes>0&&props.device.freeBytes>=0?Math.min(100,Math.max(0,(1-props.device.freeBytes/props.device.totalBytes)*100)):null);
const facts=computed(()=>{
 const c=props.device,u=props.update||{},ps5=c.platform==='ps5';
 return [
  [t('Модель','Model'),c.model||t('Не сообщается приставкой','Not reported by console')],
  [t('Прошивка','Firmware'),value(c.firmware)],
  [t('Сопряжение','Pairing'),c.online?(c.paired?t('Подтверждено','Verified'):t('Не подтверждено','Unconfirmed')):c.pairingConfigured?t('Ключ сохранён · нужна проверка','Key saved · check required'):unknown()],
  [t('Служба PackageFlow','PackageFlow service'),value(c.version)],
  [ps5?t('Приложение PackageFlow','PackageFlow application'):t('Пакет PackageFlow','PackageFlow package'),ps5?(u.appInstalled===false?t('Не установлено','Not installed'):value(u.appCurrent)):value(c.pkgVersion)],
  [t('Подключение','Transport'),c.transport==='payload'?'GoldHEN / PyLoader':t('Служба приставки','Console service')],
  [t('Форматы установки','Install formats'),c.capabilities?.formats?.length?c.capabilities.formats.map(f=>f.toUpperCase()).join(' · '):unknown()],
  [t('Режим службы','Service mode'),c.online?(c.capabilities?.background?t('Фоновый','Background'):t('Обычный','Foreground')):unknown()],
  ...(ps5?[[t('Backend образов','Image backend'),value(c.capabilities?.images?.backend)]]:[[t('HEN','HEN'),[c.henName,c.henVersion].filter(Boolean).join(' ')||unknown()]]),
  ...(c.henSdk?[[t('HEN SDK','HEN SDK'),c.henSdk]]:[]),
  [t('PID службы','Service PID'),value(c.servicePid)],
  ...(ps5?[[t('Сборка ELF','ELF build'),value(c.serviceBuild)]]:[])
 ].filter(([label])=>!props.compact||![t('Прошивка','Firmware'),t('Служба PackageFlow','PackageFlow service'),t('Приложение PackageFlow','PackageFlow application'),t('Пакет PackageFlow','PackageFlow package')].includes(label));
});
</script>
<template>
<article :class="compact?'console-details compact':'glass console-details'" aria-label="Console details">
 <div v-if="!compact" class="console-details-heading"><span class="console-platform">{{device.platform.toUpperCase()}}</span><div><h2>{{device.name}}</h2><p>{{device.ip}}</p></div><span class="status" :class="{online:device.online}"><i :class="{ready:device.online}"></i>{{device.online?t('В сети','Online'):device.restMode?t('В режиме покоя','Rest mode'):t('Нет связи','Offline')}}</span></div>
 <p class="console-freshness">{{t('Последняя проверка','Last checked')}} · {{time(device.checkedAt)}}<span v-if="!device.online"> · {{t('Сведения требуют подтверждения','Details need verification')}}</span></p>
 <dl class="console-facts"><div v-for="[label,text] in facts" :key="label"><dt>{{label}}</dt><dd>{{text}}</dd></div></dl>
 <div class="console-storage"><div><span>{{t('Хранилище','Storage')}}</span><strong>{{bytes(device.freeBytes)}} <small v-if="device.totalBytes">/ {{bytes(device.totalBytes)}}</small></strong></div><progress v-if="used!==null" :value="used" max="100" :aria-label="t('Занятое место','Used space')"/><small>{{t('Свободно','Free')}}<span v-if="device.totalBytes"> · {{t('индикатор показывает занятое место','bar shows used space')}}</span></small></div>
 <p v-if="Number.isFinite(device.transferFreeBytes)" class="console-note">{{t('Доступно для передач','Available for transfers')}}: {{bytes(device.transferFreeBytes)}}</p>
 <p v-if="device.capabilitiesDeferred" class="console-note">{{t('Во время передачи используется последняя подтверждённая готовность установки.','During a transfer, the last verified installation readiness is shown.')}}</p>
 <p v-if="device.platform==='ps5'" class="console-note">{{update?.appCheckedAt?t('Версия приложения проверена','Application version checked')+' · '+time(update.appCheckedAt):t('Нажмите «Проверить», чтобы прочитать установленную версию приложения.','Click Check to read the installed application version.')}}</p>
 <p v-if="update?.appMessage" class="console-note">{{update.appMessage}}</p>
</article>
</template>
