import assert from 'node:assert/strict'
import {test} from 'node:test'
import {build} from 'esbuild'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,rmSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'

function pkg(values){
 const keys=Buffer.concat(Object.keys(values).map(k=>Buffer.from(`${k}\0`))),data=Buffer.concat(Object.values(values).map(v=>Buffer.from(`${v}\0`))),count=Object.keys(values).length
 const s=Buffer.alloc(20+16*count+keys.length+data.length);s.writeUInt32LE(0x46535000);s.writeUInt32LE(20+count*16,8);s.writeUInt32LE(20+count*16+keys.length,12);s.writeUInt32LE(count,16)
 let k=0,v=0;Object.entries(values).forEach(([key,value],i)=>{const at=20+i*16,n=Buffer.byteLength(value)+1;s.writeUInt16LE(k,at);s.writeUInt16LE(0x204,at+2);s.writeUInt32LE(n,at+4);s.writeUInt32LE(n,at+8);s.writeUInt32LE(v,at+12);k+=Buffer.byteLength(key)+1;v+=n})
 keys.copy(s,20+count*16);data.copy(s,20+count*16+keys.length)
 const p=Buffer.alloc(8192);Buffer.from('7f434e54','hex').copy(p);p.writeUInt32BE(1,16);p.writeUInt32BE(128,24);Buffer.from(values.CONTENT_ID).copy(p,64);p.writeUInt32BE(0x1000,128);p.writeUInt32BE(256,144);p.writeUInt32BE(s.length,148);s.copy(p,256);return p
}
test('live two-game selection, insufficient space, changed reviews, explicit queue admission, and selected PS4 reinstallation',async()=>{
 const work=mkdtempSync(join(tmpdir(),'pf-live-review-')),oldData=process.env.PACKAGEFLOW_DATA_DIR,oldFetch=globalThis.fetch,oldHost=process.env.PACKAGEFLOW_HOST_IP
 const data=join(work,'data');mkdirSync(data);process.env.PACKAGEFLOW_DATA_DIR=data;process.env.PACKAGEFLOW_HOST_IP='192.168.1.2'
 try{
  const bundle=join(work,'api.mjs');await build({stdin:{contents:"export * from './server/utils/device-installation';export * from './server/utils/native-install-review';export * from './server/utils/console-app-commands';export * from './server/utils/console-profiles';export * from './server/utils/package-library';export * from './server/utils/installation-queue';export * from './server/utils/selected-reinstallation';export * from './server/utils/maintenance-store';",resolveDir:resolve('.')},outfile:bundle,bundle:true,platform:'node',format:'esm',logLevel:'silent'})
  const api=await import(pathToFileURL(bundle).href),ip='192.168.1.4',profile=api.saveConsoleProfile({name:'Test PS4',ip,platform:'ps4'}).consoles[0]
  writeFileSync(join(data,'ps4-service-keys.json'),JSON.stringify({[ip]:'a'.repeat(32)}))
  const make=(id,titleId)=>{const contentId=`IV0000-${titleId}_00-PACKAGEFLOWUI001`,path=join(work,`${id}.pkg`);writeFileSync(path,pkg({TITLE:id,TITLE_ID:titleId,CONTENT_ID:contentId,CATEGORY:'gd',APP_VER:'01.00',SYSTEM_VER:'0x05050000'}));return{id,title:id,titleId,contentId,appVersion:'01.00',platform:'ps4',format:'pkg',contentType:'PS4GD',size:8192,path,fileName:`${id}.pkg`,libraryRoot:work,sourceModifiedAt:1,iconSize:0,icon:{offset:0,size:0},type:'Игра',installOrder:0}}
  const old=make('old','CUSA95001'),fresh=make('new','CUSA95002'),unselected=make('LittleNightmares','CUSA95003')
  let items=[old,{...fresh,size:2*1024**3},unselected],free=1024**3,revision='a'.repeat(16),broken=false
  const library=()=>writeFileSync(join(data,'package-library.json'),JSON.stringify({version:2,packages:items,deliveries:{}}));library()
  const component=p=>({id:'base',kind:'base',title:p.title,version:p.appVersion,contentId:p.contentId,sizeBytes:8192,storage:'internal',canRemove:true})
  const inventory=new Map([[old.titleId,[component(old)]],[unselected.titleId,[component(unselected)]]]),removals=new Map(),posts=[],removed=[]
  let delayRemoval=false,holdRuntime=false,runtimeEntered,releaseRuntime
  const cap={service:'PackegeFlowService',version:'0.4.0',installApi:1,authentication:'bearer',ready:true,contentTypes:['PS4GD','PS4GP','PS4AC'],error:0,errorHex:'0x00000000'}
  const response=(v,status=200)=>new Response(JSON.stringify(v),{status})
  globalThis.fetch=async(url,options={})=>{
   const u=new URL(url),path=u.pathname;assert.equal(u.hostname,ip)
   if(path==='/ping'||path==='/status'||path==='/install/capabilities'||path==='/install/session')return response({...cap,status:'ok'})
   if(path==='/system/info')return response({...cap,environment:'ps4',firmware:{version:'12.50'},model:{name:'Slim',family:'Slim'},hen:{}})
   if(path==='/storage')return response({...cap,volumes:[{id:'internal',path:'/user',available:true,totalBytes:20*1024**3,freeBytes:free,availableBytes:free,usedBytes:20*1024**3-free}]})
   if(path.startsWith('/apps/title/')){if(broken)return response({},503);const titleId=path.split('/')[3],components=inventory.get(titleId)||[];return response({service:cap.service,revision,complete:true,total:components.length,next:null,app:{titleId,title:titleId,version:'01.00',installed:components.some(c=>c.kind==='base'),protected:false},components})}
   if(path.startsWith('/apps/runtime/')){if(holdRuntime){runtimeEntered();await new Promise(resolve=>{releaseRuntime=resolve})}return response({service:cap.service,titleId:path.split('/').at(-1),running:false,appId:-1})}
   if(path==='/apps/remove'){
    const input=JSON.parse(options.body),parts=inventory.get(input.titleId)||[],affected=parts.filter(c=>input.kind==='game'||c.kind===input.kind&&c.id===input.componentId);assert.ok(affected.length)
    inventory.set(input.titleId,parts.filter(c=>!affected.includes(c)));removed.push(input);const job={service:cap.service,...input,state:delayRemoval?'verifying':'removed',completed:affected.length,total:affected.length,error:0,errorHex:'0x00000000',pollError:0};removals.set(input.requestId,job);return response(job)
   }
   if(path.startsWith('/apps/operations/'))return response(removals.get(path.split('/').at(-1)))
   if(path==='/install/jobs/active')return response({service:cap.service,active:false})
   if(path==='/install/jobs'){
    const input=JSON.parse(options.body);posts.push(input);return response({service:cap.service,jobId:input.requestId,requestId:input.requestId,contentId:input.contentId,taskId:43,state:'installed',totalBytes:input.size,downloadedBytes:input.size,downloadTotalBytes:input.size,error:0,errorHex:'0x00000000',pollError:0})
   }
   assert.fail(path)
  }
  const selected={packageIds:[old.id,fresh.id]},targets=[profile.id],preview=await api.previewDeviceInstall(selected,targets),device=preview.devices[0]
  assert.equal(preview.files,2);assert.deepEqual(preview.packages.map(p=>p.packageId),['old','new']);assert.deepEqual(device.installedPackages.map(p=>p.packageId),['old']);assert.equal(device.selectedBytes,2*1024**3);assert.equal(device.eligible,false);assert.match(device.reason,/места/)
  const denied=await api.installDeviceBatch('1'.repeat(32),selected,targets,'localhost:3000',{}, {[profile.id]:device.reviewToken});assert.equal(denied.results[0].state,'failed');assert.equal(posts.length,0);assert.equal(removed.length,0);assert.equal(api.getPackage(fresh.id).installedAt,undefined)
  // An old local mark on the absent game never changes the live preflight.
  api.markPackageInstalled(fresh.id,true,ip);const again=await api.previewDeviceInstall(selected,targets);assert.deepEqual(again.devices[0].installedPackages.map(p=>p.packageId),['old']);api.markPackageInstalled(fresh.id,false,ip)
  // Even at sufficient space, an unreviewed installed component cannot silently skip.
  items=[old,fresh,unselected];library();free=8*1024**3
  const noReview=await api.installDeviceBatch('2'.repeat(32),selected,targets,'localhost:3000');assert.equal(noReview.results[0].state,'failed');assert.equal(posts.length,0)
  const valid=await api.previewDeviceInstall(selected,targets);revision='b'.repeat(16)
  const changed=await api.installDeviceBatch('3'.repeat(32),selected,targets,'localhost:3000',{}, {[profile.id]:valid.devices[0].reviewToken});assert.match(changed.results[0].message,/изменился/);assert.equal(posts.length,0)
  const until=async(check)=>{const end=Date.now()+6000;while(!check()){assert.ok(Date.now()<end,'worker timeout');await new Promise(r=>setTimeout(r,25))}}
  // User reviewed skip on old: new game alone is dispatched, never Little Nightmares.
  const reviewed=await api.previewDeviceInstall(selected,targets)
  const started=await api.installDeviceBatch('4'.repeat(32),selected,targets,'localhost:3000',{}, {[profile.id]:reviewed.devices[0].reviewToken});assert.equal(started.results[0].state,'queued',started.results[0].message);await until(()=>api.getInstallationQueue(ip).status==='completed')
  assert.deepEqual(posts.map(p=>p.titleId),[fresh.titleId]);assert.equal(api.getPackage(old.id).installedAt,undefined,'preview skip does not write an installation mark');assert.equal(removed.length,0)
  // Reinstall only approved old and install selected new: no implicit full-library bundle.
  const replacePreview=await api.previewDeviceInstall(selected,targets)
  const replaced=await api.installDeviceBatch('5'.repeat(32),selected,targets,'localhost:3000',{[profile.id]:[old.id]}, {[profile.id]:replacePreview.devices[0].reviewToken});assert.equal(replaced.results[0].state,'queued',replaced.results[0].message);await until(()=>api.getInstallationQueue(ip).status==='completed')
  assert.deepEqual(removed.map(p=>p.titleId),[old.titleId]);assert.deepEqual(posts.slice(1).map(p=>p.titleId),[old.titleId,fresh.titleId]);assert.ok(inventory.get(unselected.titleId).length)
  // A live unknown/incomplete response never marks an absent item installed.
  await api.advanceSelectedReinstall(ip);broken=true;const unknown=await api.previewDeviceInstall({packageIds:[fresh.id]},targets);assert.equal(unknown.devices[0].eligible,false);assert.equal(unknown.devices[0].installedPackages.length,0)
  // Looking at a preflight must not restart an old pending queue.
  broken=false
  const queueFile=join(data,'consoles',ip,'installation-queue.json'),savedQueue=readFileSync(queueFile,'utf8'),postCount=posts.length
  writeFileSync(queueFile,JSON.stringify({version:1,id:'old-queue',status:'running',transport:'service',psIp:ip,items:[{packageId:unselected.id,title:unselected.title,titleId:unselected.titleId,size:unselected.size,url:'http://192.168.1.2:3000/json/LittleNightmares.json',state:'pending',detail:'Old pending task',bytesSent:0}]}))
  const withQueue=await api.previewDeviceInstall(selected,targets)
  assert.deepEqual(withQueue.packages.map(p=>p.packageId),['old','new']);assert.deepEqual(withQueue.devices[0].queuedPackages.map(p=>p.packageId),['LittleNightmares']);assert.equal(withQueue.devices[0].installedPackages.length,0)
  const noQueueReview=await api.installDeviceBatch('6'.repeat(32),selected,targets,'localhost:3000');assert.equal(noQueueReview.results[0].state,'failed');await new Promise(r=>setTimeout(r,20));assert.equal(posts.length,postCount,'preflight and rejected admission never restart the old queue')
  writeFileSync(queueFile,savedQueue)
  assert.equal(api.replacementCoversComponents([{kind:'base',contentId:old.contentId},{kind:'dlc',contentId:'DLC'}],[old]),false)
  // Reload every bundled module from disk while removal is pending: recover with GET only.
  inventory.set(old.titleId,[component(old)]);delayRemoval=true
  const steps=await api.selectedReinstallPlan(ip,[old.id]),removeCount=removed.length
  const flowInput={packageIds:[old.id],packageUrls:{[old.id]:'http://192.168.1.2:3000/json/old.json'}}
  await api.beginSelectedReinstall(ip,flowInput,steps)
  assert.equal(api.readMaintenance()[ip].state,'removing');assert.equal(removed.length,removeCount+1)
  const resumedBundle=join(work,'restarted.mjs');copyFileSync(bundle,resumedBundle)
  const restarted=await import(pathToFileURL(resumedBundle).href)
  removals.get(steps[0].requestId).state='removed';delayRemoval=false
  await restarted.advanceSelectedReinstall(ip)
  await until(()=>restarted.peekInstallationQueue(ip).status==='completed')
  assert.equal(removed.length,removeCount+1,'restart never repeats the removal POST')
  assert.deepEqual(restarted.peekInstallationQueue(ip).items.map(p=>p.packageId),[old.id])
  assert.equal((await restarted.advanceSelectedReinstall(ip)).state,'completed')
  // An intent persisted before the removal ledger was written cannot be replayed blindly.
  const uncertain={...restarted.readMaintenance()[ip],id:'uncertain-restart',state:'removing',index:0,steps:[{...steps[0],requestId:'01234567-89ab-4cde-8fab-0123456789ab',dispatched:true}]}
  restarted.saveMaintenance({[ip]:uncertain})
  const installsBefore=posts.length
  assert.equal((await restarted.advanceSelectedReinstall(ip)).state,'uncertain')
  assert.equal(removed.length,removeCount+1);assert.equal(posts.length,installsBefore)
  // A finished queue with an error must not report successful reinstallation.
  writeFileSync(queueFile,JSON.stringify({...restarted.peekInstallationQueue(ip),items:[{...restarted.peekInstallationQueue(ip).items[0],state:'failed'}]}))
  restarted.saveMaintenance({[ip]:{...uncertain,id:restarted.peekInstallationQueue(ip).id,state:'installing'}})
  assert.equal((await restarted.advanceSelectedReinstall(ip)).state,'failed')
  // Stop while the worker awaits runtime: no next removal or installation may slip through.
  inventory.set(old.titleId,[component(old)])
  const stopFlow={...uncertain,id:'stop-test',state:'removing',cancelRequested:false,index:0,steps:[{...steps[0],dispatched:false}]}
  restarted.saveMaintenance({[ip]:stopFlow});holdRuntime=true
  const entered=new Promise(resolve=>{runtimeEntered=resolve}),working=restarted.advanceSelectedReinstall(ip)
  await entered;await restarted.stopSelectedReinstall(ip,stopFlow.id);holdRuntime=false;releaseRuntime();await working
  assert.equal((await restarted.advanceSelectedReinstall(ip)).state,'failed')
  assert.equal(removed.length,removeCount+1);assert.equal(posts.length,installsBefore)
  // "Reinstall all" includes non-CUSA PS2 Classics and every selected game.
  // Previously SLES was treated as absent, so it never received a removal POST.
  const classic=make('classic','SLES53741')
  items=[old,fresh,classic,unselected];library()
  for(const p of [old,fresh,classic])inventory.set(p.titleId,[component(p)])
  restarted.saveMaintenance({})
  const multiSelection={packageIds:[old.id,fresh.id,classic.id]}
  const multiPreview=await restarted.previewNativeInstall({ip,gameId:'favorites',action:'install-favorites',favoriteIds:[old.titleId,fresh.titleId,classic.titleId]},'ps4')
  assert.deepEqual(multiPreview.device.installedPackages.map(p=>p.packageId).sort(),['classic','new','old'])
  assert.ok(multiPreview.device.installedPackages.every(p=>p.canReinstall))
  assert.equal(multiPreview.consoleId,profile.id);assert.equal(multiPreview.consolePlatform,'ps4')
  const removedBefore=removed.length,postsBefore=posts.length
  const multiCommand={ip,consoleId:profile.id,gameId:'review',requestId:'7'.repeat(32),action:'install-reviewed',packageIds:multiPreview.selection.packageIds,overwritePackageIds:multiSelection.packageIds,reviewToken:multiPreview.device.reviewToken}
  restarted.submitConsoleCommand(multiCommand,'3000')
  await until(()=>restarted.consoleCommand(multiCommand.requestId,ip).state!=='pending')
  assert.equal(restarted.consoleCommand(multiCommand.requestId,ip).state,'accepted',restarted.consoleCommand(multiCommand.requestId,ip).message)
  for(let n=0;n<80;n++){
    await restarted.advanceSelectedReinstall(ip)
    if(restarted.readMaintenance()[ip].state==='completed')break
    await new Promise(r=>setTimeout(r,25))
  }
  assert.equal(restarted.readMaintenance()[ip].state,'completed',restarted.readMaintenance()[ip].message)
  assert.deepEqual(removed.slice(removedBefore).map(r=>r.titleId).sort(),[old.titleId,fresh.titleId,classic.titleId].sort(),'all three games are removed, each with its own command')
  assert.deepEqual(posts.slice(postsBefore).map(r=>r.titleId).sort(),[old.titleId,fresh.titleId,classic.titleId].sort(),'all three games are installed after removals')
  assert.ok(restarted.peekInstallationQueue(ip).items.every(item=>item.state==='installed'),'approved replacement is never silently skipped')
  assert.ok(inventory.get(unselected.titleId).length,'unselected Little Nightmares is not touched')
  const installsAfter=posts.length,removalsAfter=removed.length
  assert.equal(restarted.submitConsoleCommand(multiCommand,'3000').state,'accepted')
  assert.equal(posts.length,installsAfter);assert.equal(removed.length,removalsAfter)
  assert.throws(()=>restarted.submitConsoleCommand({...multiCommand,overwritePackageIds:[old.id]},'3000'),/другой командой/)
  assert.throws(()=>restarted.submitConsoleCommand({...multiCommand,requestId:'8'.repeat(32),reviewToken:'invalid'},'3000'),/проверку/)
 }finally{globalThis.fetch=oldFetch;if(oldData===undefined)delete process.env.PACKAGEFLOW_DATA_DIR;else process.env.PACKAGEFLOW_DATA_DIR=oldData;if(oldHost===undefined)delete process.env.PACKAGEFLOW_HOST_IP;else process.env.PACKAGEFLOW_HOST_IP=oldHost;rmSync(work,{recursive:true,force:true})}
})
