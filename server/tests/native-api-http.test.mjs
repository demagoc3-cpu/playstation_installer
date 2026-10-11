import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { putPs5ParamPkg } from './fixtures/ps5-param-pkg.mjs'

function ps4Pkg(values) {
  const keys=Buffer.concat(Object.keys(values).map(k=>Buffer.from(k+'\0'))),data=Buffer.concat(Object.values(values).map(v=>Buffer.from(v+'\0'))),count=Object.keys(values).length
  const s=Buffer.alloc(20+16*count+keys.length+data.length);s.writeUInt32LE(0x46535000);s.writeUInt32LE(20+count*16,8);s.writeUInt32LE(20+count*16+keys.length,12);s.writeUInt32LE(count,16)
  let k=0,v=0;Object.entries(values).forEach(([key,value],i)=>{const at=20+i*16,n=Buffer.byteLength(value)+1;s.writeUInt16LE(k,at);s.writeUInt16LE(0x204,at+2);s.writeUInt32LE(n,at+4);s.writeUInt32LE(n,at+8);s.writeUInt32LE(v,at+12);k+=Buffer.byteLength(key)+1;v+=n})
  keys.copy(s,20+count*16);data.copy(s,20+count*16+keys.length)
  const p=Buffer.alloc(8192);Buffer.from('7f434e54','hex').copy(p);p.writeUInt32BE(1,16);p.writeUInt32BE(128,24);Buffer.from(values.CONTENT_ID).copy(p,64);p.writeUInt32BE(0x1000,128);p.writeUInt32BE(256,144);p.writeUInt32BE(s.length,148);s.copy(p,256);return p
}
test('real Nuxt routes: native v1/v2 reads, receipts, task removal and reviewed multiple-game installation', {timeout:60000}, async()=>{
  assert.ok(existsSync('.output/server/index.mjs'),'Run Nuxt build before the HTTP integration test')
  const dir=mkdtempSync(join(tmpdir(),'pf-native-http-')),data=join(dir,'data');mkdirSync(data)
  const net=createServer();await new Promise(r=>net.listen(0,'127.0.0.1',r));const port=net.address().port;await new Promise(r=>net.close(r))
  const profiles=[{id:'four',name:'PS4 fixture',ip:'192.168.50.4',platform:'ps4',transport:'service'}, {id:'other',name:'Other PS4',ip:'192.168.50.6',platform:'ps4',transport:'service'}, {id:'five',name:'PS5 fixture',ip:'192.168.50.5',platform:'ps5',transport:'service'}]
  writeFileSync(join(data,'console-profiles.json'),JSON.stringify({version:1,activeId:null,consoles:profiles}))
  writeFileSync(join(data,'ps4-service-keys.json'),JSON.stringify({'192.168.50.4':'a'.repeat(32),'192.168.50.6':'b'.repeat(32)}))
  writeFileSync(join(data,'ps5-service-keys.json'),JSON.stringify({'192.168.50.5':'a'.repeat(64)}))
  const pkg=(id,titleId)=>{
    const contentId=`IV0000-${titleId}_00-PACKAGEFLOWUI001`,path=join(dir,id+'.pkg');writeFileSync(path,ps4Pkg({TITLE:id,TITLE_ID:titleId,CONTENT_ID:contentId,CATEGORY:'gd',APP_VER:'01.00',SYSTEM_VER:'0x05050000'}))
    return {id,title:id,titleId,contentId,appVersion:'01.00',platform:'ps4',format:'pkg',contentType:'PS4GD',size:8192,path,fileName:id+'.pkg',libraryRoot:dir,sourceModifiedAt:1,iconSize:0,icon:{offset:0,size:0},type:'Игра',installOrder:0}
  }
  const old=pkg('old','CUSA95001'),classic=pkg('classic','SLES53741'),fresh=pkg('fresh','CUSA95002'),untouched=pkg('untouched','CUSA95003')
  const five={...old,id:'native-five',title:'PS5 fixture',titleId:'PPSA95001',contentId:'IV0000-PPSA95001_00-PACKAGEFLOWUI001',appVersion:'01.000.001',platform:'ps5',contentType:'PS5GD',path:join(dir,'five.pkg'),fileName:'five.pkg'}
  writeFileSync(five.path,putPs5ParamPkg(Buffer.alloc(8192)))
  writeFileSync(join(data,'package-library.json'),JSON.stringify({version:2,packages:[old,classic,fresh,untouched,five],deliveries:{}}))
  const component=p=>({id:'base',kind:'base',title:p.title,version:p.appVersion,contentId:p.contentId,sizeBytes:p.size,storage:'internal',canRemove:true})
  writeFileSync(join(data,'fixture-state.json'),JSON.stringify({inventory:{'192.168.50.4':{[old.titleId]:[component(old)],[classic.titleId]:[component(classic)],[untouched.titleId]:[component(untouched)]},'192.168.50.6':{}},removals:{},jobs:{},five:[{title_id:five.titleId,installed:true,source_available:true,content_id:five.contentId,version:five.appVersion,path:'/fixture/five',sourceIdentity:'a'.repeat(64)}]}))
  const qi=(id)=>({packageId:id,titleId:'CUSA99999',title:id,fileName:id+'.pkg',type:'Игра',size:100,bytesSent:100,state:'installed',detail:'fixture receipt'})
  for(const profile of profiles.filter(p=>p.platform==='ps4')){
    const folder=join(data,'consoles',profile.ip);mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'installation-queue.json'),JSON.stringify({version:1,id:'fixture-queue',status:'completed',transport:'service',psIp:profile.ip,items:[qi('history-record')]}))
    writeFileSync(join(folder,'installation-history.json'),JSON.stringify([{version:1,id:'fixture-past',status:'completed',transport:'service',psIp:profile.ip,items:Array.from({length:61},(_,i)=>qi('past-'+i))}]))
  }
  const fiveDir=join(data,'consoles','five');mkdirSync(fiveDir,{recursive:true});writeFileSync(join(fiveDir,'ps5-installation-queue.json'),JSON.stringify({version:1,consoleId:'five',psIp:profiles[2].ip,id:'five-queue',status:'failed',createdAt:1,items:[{...qi('five-history'),titleId:five.titleId,transferId:'a'.repeat(32),platform:'ps5',format:'pkg',branch:'ps5:PPSA95001',order:0},{...qi('five-accepted'),titleId:'PPSA95002',transferId:'b'.repeat(32),platform:'ps5',format:'pkg',branch:'ps5:PPSA95002',order:0,state:'unconfirmed',installDispatched:true}],history:[]}))
  let output='';const child=spawn(process.execPath,['--import',resolve('server/tests/fixtures/native-http-service.mjs'),resolve('.output/server/index.mjs')],{env:{...process.env,PACKAGEFLOW_DATA_DIR:data,PACKAGEFLOW_LAUNCHER_KEY:'fixture-launcher-key',PACKAGEFLOW_HOST_IP:'192.168.50.2',NITRO_HOST:'127.0.0.1',NITRO_PORT:String(port),HOST:'127.0.0.1',PORT:String(port)},stdio:['ignore','pipe','pipe']})
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b)
  const base=`http://127.0.0.1:${port}`,pause=()=>new Promise(r=>setTimeout(r,30))
  const get=async path=>{const r=await fetch(base+path);assert.equal(r.status,200,await r.clone().text());assert.equal(r.headers.get('cache-control'),'no-store');return r.json()}
  const post=async(path,body,code=200)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,code,await r.clone().text());return r.json()}
  const command=async(version,body)=>{await post(`/api/catalog/v${version}/command`,body);for(let n=0;n<150;n++){const r=await get(`/api/catalog/v${version}/command?${version===1?'ip='+body.ip:'consoleId='+body.consoleId}&id=${body.requestId}`);if(r.state!=='pending')return r;await pause()}assert.fail('command timed out: '+output)}
  const trace=()=>existsSync(join(data,'fixture-trace.jsonl'))?readFileSync(join(data,'fixture-trace.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[]
  try{
    const snapshots={}
    for(let n=0;n<150;n++){try{const r=await fetch(base+'/api/catalog/v2/activity?consoleId=five&source=tasks');if(r.status===200)break}catch{}assert.equal(child.exitCode,null,output);await pause()}
    const defaultCatalog=await get('/api/catalog/v1?ip=192.168.50.4')
    assert.equal(defaultCatalog.platform,'ps4');assert.equal(defaultCatalog.games.some(g=>g.platform==='ps5'),false,'legacy v1 defaults to PS4')
    const mixedCatalog=await get('/api/catalog/v1?ip=192.168.50.4&platform=all&sort=title-desc')
    assert.equal(mixedCatalog.capabilities.catalogFeatures.platformFilter,true);assert.equal(mixedCatalog.sort,'title-desc')
    assert.ok(mixedCatalog.games.some(g=>g.platform==='ps4'));assert.ok(mixedCatalog.games.some(g=>g.platform==='ps5'))
    const onlyFive=await get('/api/catalog/v1?ip=192.168.50.4&platform=ps5')
    assert.equal(onlyFive.games.length,1);assert.equal(onlyFive.games[0].details.titleId,five.titleId)
    assert.equal(onlyFive.games[0].packages[0].format,'pkg');assert.equal(onlyFive.games[0].packages[0].contentId,five.contentId)
    assert.equal(JSON.stringify(mixedCatalog).includes(dir),false,'extended metadata still hides source paths')
    assert.equal((await fetch(base+'/api/desktop/console-setup?consoleId=five')).status,404,'setup is only available to the Windows launcher')
    const launcherHeaders={'x-packageflow-launcher-key':'fixture-launcher-key','Content-Type':'application/json'}
    assert.equal((await fetch(base+'/api/desktop/console-setup?consoleId=four',{headers:launcherHeaders})).status,400,'PS5 bootstrap rejects a PS4 target')
    const missingBundle=await fetch(base+'/api/desktop/console-setup',{method:'POST',headers:launcherHeaders,body:JSON.stringify({action:'bootstrap',consoleId:'five',firmware:'13.60'})})
    assert.equal(missingBundle.status,409,'no bundle means no ELF delivery')
    const unsafeOrigin=await fetch(base+'/api/desktop/console-setup',{method:'POST',headers:{...launcherHeaders,Origin:'http://another-origin.invalid'},body:JSON.stringify({action:'bootstrap',consoleId:'five'})})
    assert.equal(unsafeOrigin.status,403)
    const one=await get('/api/catalog/v1/activity?ip=192.168.50.4&source=tasks&page=1&mask=15')
    assert.equal(one.tasks.length,50);assert.equal(one.taskPages,2);assert.equal(one.tasks[0].packageId,one.tasks[0].id);assert.equal(one.tasks[0].canDismiss,true);assert.equal(one.tasks[0].branchId,'ps4:CUSA99999');assert.deepEqual(one.taskControls.actions,['remove-items','remove-games','stop-reinstall'])
    const fiveTasks=await get('/api/catalog/v2/activity?consoleId=five&source=tasks');assert.equal(fiveTasks.consolePlatform,'ps5');assert.equal(fiveTasks.tasks.find(t=>t.packageId==='five-history').id,'a'.repeat(32));assert.equal(fiveTasks.tasks.find(t=>t.packageId==='five-accepted').canDismiss,false)
    snapshots['ps4-activity.json']=one;snapshots['ps5-activity.json']=fiveTasks
    const req={ip:profiles[0].ip,gameId:'tasks',action:'remove-games',requestId:'1'.repeat(32),queueId:'fixture-past',gameIds:['ps4:CUSA99999']}
    assert.equal((await command(1,req)).state,'accepted');assert.equal((await command(1,req)).state,'accepted')
    assert.equal((await get('/api/catalog/v1/activity?ip=192.168.50.4&source=tasks')).taskTotal,1)
    assert.equal((await get('/api/catalog/v1/activity?ip=192.168.50.6&source=tasks')).taskTotal,62)
    await post('/api/catalog/v1/command',{...req,queueId:'changed'},409)
    const r5={consoleId:'five',gameId:'tasks',action:'remove-items',requestId:'2'.repeat(32),queueId:'five-queue',packageIds:['five-history']}
    assert.equal((await command(2,r5)).state,'completed')
    assert.equal((await command(2,{...r5,requestId:'3'.repeat(32),packageIds:['five-accepted']})).state,'failed')
    assert.ok((await get('/api/catalog/v2/activity?consoleId=five&source=tasks')).tasks.some(t=>t.packageId==='five-accepted'))
    const previewBody={ip:profiles[0].ip,gameId:'favorites',action:'install-favorites',favoriteIds:[old.titleId,classic.titleId,fresh.titleId]}
    const review=await post('/api/catalog/v1/install-preview',previewBody)
    snapshots['ps4-install-preview.json']=review
    assert.equal(review.device.eligible,true,review.device.reason);assert.deepEqual(review.device.installedPackages.map(p=>p.packageId).sort(),['classic','old']);assert.equal(review.consoleId,'four');assert.equal(JSON.stringify(review).includes(dir),false,'no source paths or credentials in native preview')
    const reviewed={ip:profiles[0].ip,consoleId:'four',gameId:'review',action:'install-reviewed',requestId:'4'.repeat(32),packageIds:review.selection.packageIds,overwritePackageIds:[],reviewToken:review.device.reviewToken}
    assert.equal((await command(1,reviewed)).state,'accepted')
    for(let n=0;n<150&&trace().filter(r=>r.path==='/install/jobs').length===0;n++)await pause()
    assert.equal(trace().filter(r=>r.path==='/install/jobs').length,1,'skip old games installs only the new selected game')
    const again=await post('/api/catalog/v1/install-preview',previewBody);assert.equal(again.device.installedPackages.length,3)
    const replace={...reviewed,requestId:'5'.repeat(32),reviewToken:again.device.reviewToken,overwritePackageIds:again.selection.packageIds}
    const accepted=await command(1,replace);assert.equal(accepted.state,'accepted',accepted.message)
    snapshots['ps4-install-reviewed-command.json']=replace;snapshots['ps4-install-reviewed-receipt.json']=accepted
    for(let n=0;n<200;n++){const a=await get('/api/catalog/v1/activity?ip=192.168.50.4&source=tasks');if(a.maintenance?.state==='completed')break;await pause()}
    assert.equal(trace().filter(r=>r.path==='/apps/remove').length,3,'each selected game, including SLES, gets its own removal')
    assert.equal(trace().filter(r=>r.path==='/install/jobs').length,4,'new game plus three reviewed reinstallations')
    const count=trace().length;assert.equal((await command(1,replace)).state,'accepted');assert.equal(trace().length,count,'replayed native request never deletes again')
    await post('/api/catalog/v1/command',{...replace,overwritePackageIds:[old.id]},409)
    const beforeStale=await post('/api/catalog/v1/install-preview',previewBody)
    const state=JSON.parse(readFileSync(join(data,'fixture-state.json'))),savedOld=state.inventory[profiles[0].ip][old.titleId]
    state.inventory[profiles[0].ip][old.titleId]=[];writeFileSync(join(data,'fixture-state.json'),JSON.stringify(state))
    const countBeforeStale=trace().length
    const stale=await command(1,{...reviewed,requestId:'7'.repeat(32),reviewToken:beforeStale.device.reviewToken})
    assert.equal(stale.state,'failed');assert.match(stale.message,/изменился/);assert.equal(trace().length,countBeforeStale,'changed review starts no removal/install')
    const currentState=JSON.parse(readFileSync(join(data,'fixture-state.json')));currentState.inventory[profiles[0].ip][old.titleId]=savedOld;writeFileSync(join(data,'fixture-state.json'),JSON.stringify(currentState))
    const flow=JSON.parse(readFileSync(join(data,'console-maintenance.json')))[profiles[0].ip]
    assert.equal((await command(1,{ip:profiles[0].ip,gameId:'tasks',action:'stop-reinstall',requestId:'8'.repeat(32),maintenanceId:flow.id})).state,'accepted')
    assert.equal((await command(1,{ip:profiles[0].ip,gameId:'tasks',action:'stop-reinstall',requestId:'9'.repeat(32),maintenanceId:'wrong-flow'})).state,'failed')
    assert.equal(trace().length,countBeforeStale)
    const p5=await post('/api/catalog/v2/install-preview',{consoleId:'five',gameId:'ps5:PPSA95001',action:'all'})
    snapshots['ps5-install-preview.json']=p5
    assert.equal(p5.schemaVersion,2);assert.equal(p5.device.installedPackages[0].packageId,five.id);assert.equal(p5.device.eligible,true,p5.device.reason)
    const skip5={consoleId:'five',gameId:'review',action:'install-reviewed',requestId:'6'.repeat(32),packageIds:p5.selection.packageIds,overwritePackageIds:[],reviewToken:p5.device.reviewToken}
    const receipt5=await command(2,skip5);assert.equal(receipt5.state,'completed')
    snapshots['ps5-install-reviewed-command.json']=skip5;snapshots['ps5-install-reviewed-receipt.json']=receipt5
    await post('/api/catalog/v2/command',{...skip5,overwritePackageIds:[five.id]},409)
    const badOrigin=await fetch(base+'/api/catalog/v1/command',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://another-origin.invalid'},body:JSON.stringify(req)});assert.equal(badOrigin.status,403)
    const badType=await fetch(base+'/api/catalog/v1/command',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'});assert.equal(badType.status,415)
    assert.ok(JSON.parse(readFileSync(join(data,'fixture-state.json'))).inventory[profiles[0].ip][untouched.titleId].length)
    if(process.env.PF_NATIVE_HTTP_CAPTURE_DIR){
      const capture=resolve(process.env.PF_NATIVE_HTTP_CAPTURE_DIR);mkdirSync(capture,{recursive:true})
      for(const [name,body] of Object.entries(snapshots))writeFileSync(join(capture,name),JSON.stringify(body,null,2)+'\n')
    }
    console.log('Real Nuxt native v1/v2 HTTP integration: PASS; synthetic consoles only')
  }catch(e){console.error(output);throw e}finally{
    child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));rmSync(dir,{recursive:true,force:true})
  }
})
