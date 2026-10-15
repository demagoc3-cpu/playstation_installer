import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createRequire} from 'node:module'
import {parse,compileScript} from '@vue/compiler-sfc'
import {build} from 'esbuild'
async function mount(file,values){
 const directory=mkdtempSync(join(tmpdir(),'pf-glass-view-'))
 const {descriptor}=parse(readFileSync(file,'utf8')),source=compileScript(descriptor,{id:'workspace-test'}).content
 const outfile=join(directory,'view.cjs')
 await build({stdin:{contents:`import {ref,reactive,computed,watch,nextTick} from 'vue';const useAppLocale=()=>({t:s=>s,formatLocale:ref('ru-RU')});const onMounted=()=>{},onBeforeUnmount=()=>{};export {reactive,nextTick};\n${source}`,loader:'ts',resolveDir:process.cwd()},outfile,bundle:true,platform:'node',format:'cjs',logLevel:'silent'})
 const module=createRequire(import.meta.url)(outfile),props=module.reactive(values),events=[]
 const view=module.default.setup(props,{expose(){},emit(...args){events.push(args)}})
 return {view,props,events,tick:module.nextTick,cleanup:()=>rmSync(directory,{recursive:true,force:true})}
}
test('download filters retain unknown/error jobs and bulk controls target only selected hashes once',async()=>{
 const controls=[],row=(hash,state,progress=0)=>({hash,name:hash,state,progress,size:1024,downloaded:0,speed:0,seeds:0,eta:0,autoInstall:false})
 const h=await mount('app/components/DownloadsPanel.vue',{items:[row('active','downloading'),row('queued','queuedDL'),row('paused','stoppedDL'),row('done','uploading',1),row('unknown','unknown')],ready:true,files:{},ps5:true,control:async(item,action)=>controls.push([item.hash,action])})
 try {const v=h.view;assert.equal(v.visible.value.length,5);v.filter.value='active';assert.deepEqual(v.visible.value.map(x=>x.hash),['active']);v.filter.value='queued';assert.deepEqual(v.visible.value.map(x=>x.hash),['queued','paused']);v.selectAll(true);assert.deepEqual(v.selected.value,['queued','paused']);await v.batch('resume');assert.deepEqual(controls,[['queued','resume'],['paused','resume']]);v.filter.value='all';assert.equal(v.category(h.props.items[4]),'error');assert.equal(v.label(h.props.items[4]),'Статус неизвестен');h.props.items=h.props.items.filter(x=>x.hash!=='queued');await h.tick();assert.deepEqual(v.selected.value,['paused'])}finally{h.cleanup()}
})
test('event filtering and search preserve full detail text and original severity',async()=>{
 const h=await mount('app/components/EventLogPanel.vue',{entries:[{id:1,time:1,level:'info',text:'Transfer started',count:1},{id:2,time:2,level:'warn',text:'PS5 offline\nretry later',count:2},{id:3,time:3,level:'error',text:'Disk full\npath: fixture',count:1}]})
 try{const v=h.view;assert.deepEqual(v.visible.value.map(x=>x.id),[3,2,1]);v.filter.value='warn';assert.deepEqual(v.visible.value.map(x=>x.id),[2]);v.query.value='retry';assert.equal(v.visible.value[0].text,'PS5 offline\nretry later');v.query.value='disk';assert.equal(v.visible.value.length,0);v.filter.value='all';assert.equal(v.visible.value[0].id,3);assert.equal(v.labels.info,'Информация')}finally{h.cleanup()}
})
