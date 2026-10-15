import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createRequire} from 'node:module'
import {parse,compileScript,compileTemplate} from '@vue/compiler-sfc'
import {build} from 'esbuild'

test('task controls send scoped removal for each queue, keep errors visible, and uncheck pending rows',async()=>{
 const work=mkdtempSync(join(tmpdir(),'pf-task-controls-')),calls=[],original=globalThis.pfTaskFetch
 globalThis.pfTaskFetch=async(url,options)=>{calls.push({url,options});if(options.method==='POST')return{message:'Removed'};return{active:[],items:[],counts:{active:0,queued:0,completed:0,failed:0},page:1,pages:1,total:0,unit:'games'}}
 try{
  const {descriptor}=parse(readFileSync('app/components/InstallationTasks.vue','utf8'))
  const script=compileScript(descriptor,{id:'task-controls'}),template=compileTemplate({source:descriptor.template.content,id:'task-controls',filename:'InstallationTasks.vue',compilerOptions:{bindingMetadata:script.bindings}})
  assert.deepEqual(template.errors,[])
  const contents=`import {ref,computed,reactive} from 'vue';const watch=()=>{},onMounted=()=>{},onUnmounted=()=>{};const useAppLocale=()=>({t:s=>s});const $fetch=(url,options)=>globalThis.pfTaskFetch(url,options);const window={confirm:()=>true};const localStorage={getItem:()=>null,setItem:()=>{}};\n${script.content}`
  const outfile=join(work,'tasks.cjs');await build({stdin:{contents,loader:'ts',resolveDir:resolve('.')},alias:{'#shared':resolve('shared')},outfile,bundle:true,platform:'node',format:'cjs',logLevel:'silent'})
  const view=createRequire(import.meta.url)(outfile).default.setup({consoleId:'selected-ps4',platform:'ps4',ip:'10.1.10.32',visible:true,torrents:[],queueStatus:'failed',cancelling:false},{expose(){},emit(){}})
  const items=[{id:'old:a',queueId:'old',packageId:'a',platform:'ps4',titleId:'CUSA03887',canDismiss:true},{id:'current:b',queueId:'current',packageId:'b',platform:'ps4',titleId:'CUSA03887',canCancel:true}]
  await view.removeTasks(items,true)
  const posts=calls.filter(c=>c.options.method==='POST')
  assert.equal(posts.length,2);assert.deepEqual(posts.map(p=>p.options.body.queueId),['old','current'])
  for(const p of posts){assert.equal(p.options.body.consoleId,'selected-ps4');assert.deepEqual(p.options.body.branches,['ps4:CUSA03887']);assert.equal(p.options.body.packageIds,undefined);assert.equal(p.options.body.action,'remove')}
  calls.length=0;await view.removeTasks([items[0]])
  assert.deepEqual(calls[0].options.body.packageIds,['a']);assert.equal(calls[0].options.body.queueId,'old')
  calls.length=0;await view.cancelBranch([items[1]])
  assert.equal(calls[0].options.body.action,'cancel');assert.equal(calls[0].options.body.queueId,'current');assert.deepEqual(calls[0].options.body.branches,['ps4:CUSA03887'])
  view.data.value.queueId='current';view.data.value.canCancelAll=true
  calls.length=0;await view.cancelAll();assert.equal(calls[0].options.body.action,'cancel');assert.equal(calls[0].options.body.queueId,'current')
  calls.length=0;await view.resumeQueue('stopped');assert.equal(calls[0].options.body.action,'resume');assert.equal(calls[0].options.body.queueId,'stopped');assert.equal(calls[0].options.body.consoleId,'selected-ps4')
  calls.length=0;await view.stopWaiting({id:'unknown',queueId:'uncertain',packageId:'image',canStopWaiting:true})
  assert.equal(calls[0].options.body.action,'stop-waiting');assert.equal(calls[0].options.body.queueId,'uncertain');assert.equal(calls[0].options.body.packageId,'image');assert.equal(calls[0].options.body.consoleId,'selected-ps4')
  view.data.value.maintenance={id:'flow',canStop:true,title:'selected',state:'removing',message:''}
  calls.length=0;await view.stopReinstall();assert.equal(calls[0].options.body.action,'stop-reinstall');assert.equal(calls[0].options.body.queueId,'flow')
  // Compile and run the actual row handler: unchecking requests cancellation of exactly that row.
  const row=parse(readFileSync('app/components/InstallationTaskRow.vue','utf8')).descriptor,rowScript=compileScript(row,{id:'row'})
  const rowOut=join(work,'row.cjs');await build({stdin:{contents:`import {ref} from 'vue';const watch=()=>{};const useAppLocale=()=>({t:s=>s});${rowScript.content}`,loader:'ts',resolveDir:resolve('.')},alias:{'#shared':resolve('shared')},outfile:rowOut,bundle:true,platform:'node',format:'cjs',logLevel:'silent'})
  const emitted=[],task={...items[1],category:'queued',state:'pending'}
  const rowView=createRequire(import.meta.url)(rowOut).default.setup({task,busy:false},{expose(){},emit:(...args)=>emitted.push(args)})
  rowView.select(false);assert.deepEqual(emitted,[['cancel',task]])
 }finally{if(original===undefined)delete globalThis.pfTaskFetch;else globalThis.pfTaskFetch=original;rmSync(work,{recursive:true,force:true})}
})
