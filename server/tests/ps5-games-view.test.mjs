import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createRequire} from 'node:module'
import {parse,compileScript} from '@vue/compiler-sfc'
import {build} from 'esbuild'

test('PS5 launch preserves pre-dispatch errors and reconciles only ambiguous replies',async()=>{
 const previousCrypto=globalThis.crypto;Object.defineProperty(globalThis,'crypto',{configurable:true,value:{getRandomValues:previousCrypto.getRandomValues.bind(previousCrypto)}})
 const work=mkdtempSync(join(tmpdir(),'pf-games-view-'));let mode='rejected',statusReads=0,dispatches=0
 const error=(message,data)=>Object.assign(Error(message),{data:{message,data}})
 globalThis.pfGamesViewFixture={async request(route,options){
   assert.equal(options.body.consoleId,'selected-ps5');if(options.body.requestId)assert.match(options.body.requestId,/^[a-f0-9]{32}$/)
   if(route.endsWith('/game-command')){dispatches++;if(mode==='rejected')throw error('Сначала завершите восстановление',{commandNotDispatched:true});throw Error('Connection lost')}
   if(route.endsWith('/game-command-status')){statusReads++;throw error('Запись команды не найдена',{commandRecordMissing:true})}
   throw Error('Unexpected request '+route)
 }}
 try{
  const {descriptor}=parse(readFileSync('app/components/Ps5ConsoleApps.vue','utf8'))
  const script=compileScript(descriptor,{id:'games-view-test'}).content
  const contents=`import {ref,computed,watch,nextTick} from 'vue';export {nextTick};
  const useConsoleRequest=()=>globalThis.pfGamesViewFixture.request;
  const useAppLocale=()=>({t:s=>s,formatLocale:ref('ru-RU')});
  const onMounted=()=>{},onBeforeUnmount=()=>{};\n${script}`
  const outfile=join(work,'view.cjs')
  await build({stdin:{contents,loader:'ts',resolveDir:process.cwd()},outfile,alias:{'#shared':resolve('shared')},bundle:true,platform:'node',format:'cjs',logLevel:'silent'})
  const module=createRequire(import.meta.url)(outfile),view=module.default.setup({consoleId:'selected-ps5'},{expose(){},emit(){}})
  view.capabilities.value={consoleControl:true}
  const row={titleId:'PPSA01325',sourceIdentity:'a'.repeat(64)}
  await view.execute(row,'launch')
  assert.equal(view.error.value,'Сначала завершите восстановление')
  assert.equal(view.command.value,undefined)
  assert.equal(Boolean(view.pending.value),false)
  assert.equal(statusReads,0,'an explicit refusal never polls a nonexistent intent or masks the cause')
  mode='lost';await view.execute(row,'launch')
  assert.equal(statusReads,1,'an ambiguous transport failure must attempt read-only reconciliation')
  assert.equal(view.command.value.state,'unconfirmed')
  assert.equal(view.command.value.recordMissing,true)
  assert.equal(view.error.value,'Connection lost','missing ledger must preserve the original transport error')
  assert.equal(view.pending.value,true,'missing receipt must not enable an automatic replay')
  await view.execute(row,'launch');assert.equal(dispatches,2,'a pending ambiguous command is not sent twice')
 }finally{Object.defineProperty(globalThis,'crypto',{configurable:true,value:previousCrypto});delete globalThis.pfGamesViewFixture;rmSync(work,{recursive:true,force:true})}
})

test('running-card state, cancelled switch, confirmed stop then launch and instance races',async()=>{
 const work=mkdtempSync(join(tmpdir(),'pf-games-switch-'))
 let active={complete:true,running:true,appId:42,titleId:'PPSA00002'},raceAfterStop=false,disposeOnActivity=false;const commands=[],receipts=new Map()
 const rows=[{titleId:'PPSA00001',title:'Next',sourceIdentity:'a'.repeat(64)},{titleId:'PPSA00002',title:'Current',sourceIdentity:'b'.repeat(64)}]
 globalThis.pfGamesViewFixture={async request(route,{body}){
  assert.equal(body.consoleId,'selected-ps5')
  if(route.endsWith('/games'))return {entries:rows,capabilities:{consoleGames:true,consoleControl:true,consoleActivity:true}}
  if(route.endsWith('/game-activity')){if(disposeOnActivity)globalThis.pfGamesViewFixture.unmount();return {...active}}
  if(route.endsWith('/game-info'))return {...rows.find(r=>r.titleId===body.titleId)}
  if(route.endsWith('/game-command')){
   commands.push(body)
   if(body.action==='stop'){assert.equal(body.titleId,'PPSA00002');assert.equal(body.expectedAppId,42);active=raceAfterStop?{complete:true,running:true,appId:43,titleId:'PPSA00003'}:{complete:true,running:false,appId:0,titleId:''}}
   else{assert.equal(body.action,'launch');assert.equal(active.running,false,'never launch while another title is active');active={complete:true,running:true,appId:44,titleId:body.titleId}}
   const v={id:body.requestId,titleId:body.titleId,action:body.action,state:'accepted',result:{running:body.action==='launch',code:0}};receipts.set(body.requestId,v);return v
  }
  if(route.endsWith('/game-command-status'))return receipts.get(body.requestId)
  throw Error('Unexpected request '+route)
 }}
 try{
  const {descriptor}=parse(readFileSync('app/components/Ps5ConsoleApps.vue','utf8'))
  const contents=`import {ref,computed,watch,nextTick} from 'vue';export {nextTick};const useConsoleRequest=()=>globalThis.pfGamesViewFixture.request;const useAppLocale=()=>({t:s=>s,formatLocale:ref('ru-RU')});const onMounted=()=>{},onBeforeUnmount=cb=>{globalThis.pfGamesViewFixture.unmount=cb};\n${compileScript(descriptor,{id:'switch-test'}).content}`
  const outfile=join(work,'view.cjs');await build({stdin:{contents,loader:'ts',resolveDir:process.cwd()},outfile,alias:{'#shared':resolve('shared')},bundle:true,platform:'node',format:'cjs',logLevel:'silent'})
  const module=createRequire(import.meta.url)(outfile),view=module.default.setup({consoleId:'selected-ps5'},{expose(){},emit(){}})
  await view.load();assert.equal(view.isRunning(rows[1]),true);assert.equal(view.state(rows[1]),'Запущено')
  await view.prepare(rows[1],'stop');assert.equal(view.confirmation.value.appId,42);assert.equal(commands.length,0)
  view.confirmation.value=undefined
  await view.prepare(rows[0],'launch');assert.equal(view.confirmation.value.action,'switch');assert.equal(commands.length,0,'opening or cancelling a prompt cannot stop the game')
  view.confirmation.value=undefined
  await view.prepare(rows[0],'launch');active.appId=99;await view.switchGame();assert.equal(commands.length,0,'a restarted game needs a fresh confirmation')
  active.appId=42;await view.prepare(rows[0],'launch');await view.switchGame()
  assert.deepEqual(commands.map(c=>c.action),['stop','launch']);assert.equal(view.isRunning(rows[0]),true);assert.equal(view.isRunning(rows[1]),false)
  commands.length=0;active={complete:true,running:true,appId:42,titleId:'PPSA00002'};raceAfterStop=true
  await view.prepare(rows[0],'launch');await view.switchGame();assert.deepEqual(commands.map(c=>c.action),['stop'],'another newly started game must survive the switch race');assert.match(view.error.value,/изменилась/)
  commands.length=0;active={complete:true,running:true,appId:42,titleId:'PPSA00002'};raceAfterStop=false
  await view.prepare(rows[0],'launch');disposeOnActivity=true;await view.switchGame();assert.equal(commands.length,0,'changing console or leaving the view must cancel a not-yet-dispatched switch')
 }finally{delete globalThis.pfGamesViewFixture;rmSync(work,{recursive:true,force:true})}
})


test('source files and details remain readable while game control is unavailable',async()=>{
 const work=mkdtempSync(join(tmpdir(),'pf-games-readonly-'));const routes=[]
 const rows=[{titleId:'PPSA00001',title:'Folder',sourceType:'folder',sourceAvailable:true,installed:true,sourceIdentity:'a'.repeat(64)},{titleId:'PPSA00002',title:'Image',sourceType:'image',sourceAvailable:true,installed:false},{titleId:'PPSA00003',title:'Registered PKG',sourceType:'pkg',sourceAvailable:false,installed:true}]
 globalThis.pfGamesViewFixture={async request(route,{body}){
  assert.equal(body.consoleId,'selected-ps5');routes.push(route)
  if(route.endsWith('/games'))return{entries:rows,capabilities:{consoleGames:false,consoleSourcesRead:true,consoleControl:false,consoleActivity:false}}
  if(route.endsWith('/game-info'))return{...rows.find(row=>row.titleId===body.titleId),path:'/data/homebrew/'+body.titleId,sizeBytes:1024}
  throw Error('Unexpected request '+route)
 }}
 try{
  const {descriptor}=parse(readFileSync('app/components/Ps5ConsoleApps.vue','utf8'))
  const contents=`import {ref,computed,watch,nextTick} from 'vue';export {nextTick};const useConsoleRequest=()=>globalThis.pfGamesViewFixture.request;const useAppLocale=()=>({t:s=>s,formatLocale:ref('ru-RU')});const onMounted=()=>{},onBeforeUnmount=()=>{};\n${compileScript(descriptor,{id:'readonly-test'}).content}`
  const outfile=join(work,'view.cjs');await build({stdin:{contents,loader:'ts',resolveDir:process.cwd()},outfile,alias:{'#shared':resolve('shared')},bundle:true,platform:'node',format:'cjs',logLevel:'silent'})
  const module=createRequire(import.meta.url)(outfile),view=module.default.setup({consoleId:'selected-ps5'},{expose(){},emit(){}})
  await view.load();view.tab.value='files'
  assert.deepEqual(view.groups.value.map(g=>g.rows.map(r=>r.titleId)),[['PPSA00001'],['PPSA00002']])
  await view.details(rows[0]);assert.equal(view.info.value.path,'/data/homebrew/PPSA00001');assert.equal(view.info.value.sizeBytes,1024)
  await view.execute(rows[0],'delete');await view.execute(rows[0],'launch')
  assert.deepEqual(routes,['/api/ps5/management/games','/api/ps5/management/game-info'],'reading sources never dispatches mutations or polls unqualified activity')
  view.tab.value='ready';await module.nextTick();await view.details(rows[2]);assert.equal(view.info.value.titleId,'PPSA00003');view.tab.value='files';await module.nextTick();assert.equal(view.info.value,undefined,'switching to source files clears a selected PKG outside that view');assert.equal(view.selected.value,'');assert.equal(routes.filter(route=>route.endsWith('/game-command')).length,0)
 }finally{delete globalThis.pfGamesViewFixture;rmSync(work,{recursive:true,force:true})}
})
