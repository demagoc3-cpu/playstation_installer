import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
const root='/home/developer/projects/web/playstation_installer';
const require=createRequire(root+'/package.json');
const {parse,compileScript,compileStyle}=require('@vue/compiler-sfc');
const {build}=require('esbuild');
await build({
  stdin:{contents:`import {createApp,ref,reactive,computed,nextTick,h} from 'vue';
import ActiveInstallationCard from '${root}/app/components/ActiveInstallationCard.vue';
import InstallationTransferSpeed from '${root}/app/components/InstallationTransferSpeed.vue';
import GlassArtwork from '${root}/app/components/GlassArtwork.vue';
import ContentTags from '${root}/app/components/ContentTags.vue';
import {locale} from 'fixture-locale';
const mode=ref('pending'), size=10.26*1024**3|0;
const task=reactive({id:'fixture',queueId:'fixture',packageId:'fixture',psIp:'192.0.2.127',title:'ASTRO’S PLAYROOM',fileName:'fixture.pkg',type:'Игра',size:11016591114,titleId:'PPSA01325',groupTitle:'ASTRO’S PLAYROOM',state:'waiting',category:'active',detail:'Установщик PS5 не запущен или недоступен',bytesSent:0,createdAt:Date.now(),transport:'service',platform:'ps5',consolePlatform:'ps5',format:'pkg',canCancel:true,cancelRequested:false});
const set=(v)=>{mode.value=v;task.state=v==='pending'?'waiting':v==='source'?'verifying':'sending';task.progressPhase=v==='source'?'source-check':'transfer';task.bytesSent=v==='pending'?0:v==='complete'?task.size:Math.round(task.size*.385);task.transferBytesPerSecond=v==='pending'||v==='source'?undefined:v==='zero'?0:v==='large'?9999.9*1048576:20.5*1048576;task.transferMeasuredAt=Date.now();task.detail=v==='long'?(locale.value==='en'?'Waiting for confirmation from the console after source verification; the service is preparing the installation. Reconnection will continue automatically.':'Ожидаем подтверждение приставки после проверки исходного файла; служба сообщает о подготовке установки. Повторное подключение выполняется автоматически.'):'Установщик PS5 не запущен или недоступен';};
const App={setup(){return()=>h('div',{class:'glass-shell'},[h('div',{class:'fixture-controls'},[h('h1','UI fixture · synthetic data'),...['pending','sending','zero','large','complete','source','long'].map(v=>h('button',{onClick:()=>set(v)},v)),h('button',{onClick:()=>locale.value=locale.value==='ru'?'en':'ru'},'RU / EN'),h('label',['Width ',h('input',{type:'number',min:260,max:1500,value:980,onInput:e=>document.querySelector('.fixture').style.width=e.target.value+'px'})])]),h('main',{class:'fixture',style:'width:980px;max-width:100%'},[h(ActiveInstallationCard,{task,canPause:true}),h('div',{class:'after-card'},'Following content')])])}};
const app=createApp(App);for(const [name,component] of Object.entries({InstallationTransferSpeed,GlassArtwork,ContentTags}))app.component(name,component);app.mount('#app');`,resolveDir:root,loader:'ts'},
  outfile:'/tmp/pf-card-fixture/app.js',bundle:true,format:'esm',platform:'browser',logLevel:'silent',
  plugins:[{name:'fixture',setup(b){
    b.onResolve({filter:/^#shared\//},a=>({path:resolve(root,'shared',a.path.slice(8)+'.ts')}));
    b.onResolve({filter:/^fixture-locale$/},a=>({path:'fixture-locale',namespace:'fixture'}));
    b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`import {ref,computed} from 'vue';import {translateText} from '${root}/app/utils/localization.ts';export const locale=ref('ru');export const useAppLocale=()=>({t:s=>translateText(s,locale.value),formatLocale:computed(()=>locale.value==='ru'?'ru-RU':'en-US')});`,resolveDir:root,loader:'ts'}));
    b.onLoad({filter:/\.vue$/},a=>{const {descriptor}=parse(readFileSync(a.path,'utf8'));const id='fixture-'+basename(a.path,'.vue');let code=compileScript(descriptor,{id,inlineTemplate:true}).content;let css=descriptor.styles.map(s=>compileStyle({source:s.content,filename:a.path,id:'data-v-'+id,scoped:s.scoped}).code).join('\n');code=code.replace('export default','const component=');return{contents:`import {ref,computed,watch,onMounted,onBeforeUnmount,onUnmounted} from 'vue';import {useAppLocale} from 'fixture-locale';\n${code}\ncomponent.__scopeId='data-v-${id}';const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.appendChild(style);export default component;`,loader:'ts',resolveDir:root};});
  }}]
});
let css=readFileSync(root+'/app/assets/css/packageflow-glass.css','utf8')+'\n'+readFileSync(root+'/app/assets/css/packageflow-workspaces.css','utf8');
writeFileSync('/tmp/pf-card-fixture/styles.css',css);
writeFileSync('/tmp/pf-card-fixture/index.html',`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PackageFlow card fixture</title><link rel="stylesheet" href="styles.css"><style>*{box-sizing:border-box}body{margin:0;background:#06152d;color:#e7f0ff;font-family:Arial,sans-serif}.glass-shell{padding:20px}.fixture-controls{padding:0 0 20px}.fixture-controls button{margin:3px}.fixture-controls input{width:80px}.glass-shell .fixture{margin:auto}.glass-artwork{display:grid;place-items:center;background:#19365a;border-radius:8px}.glass-artwork-fallback{font-size:50px}.glass-surface{border:1px solid #4579a7;border-radius:12px;background:linear-gradient(120deg,#0f3d5c,#081d34)}.after-card{padding:20px;margin-top:10px;border:1px solid #3f719b}</style><div id="app"></div><script type="module" src="app.js"></script>`);
