import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = process.cwd(), directory = mkdtempSync(resolve(tmpdir(), 'packageflow-maintenance-')), mode = process.argv[2]
process.chdir(directory); mkdirSync('.data'); globalThis.createError = v => Object.assign(new Error(v.message), v)
registerHooks({ resolve(s,c,next) { try { return next(s,c) } catch(e) { if(s.startsWith('.') && !/\.[a-z]+$/.test(s)) return next(`${s}.ts`,c); throw e } }, load(url,c,next) { if(url.endsWith('/server/utils/ps4-installer.ts')) return {format:'module',shortCircuit:true,source:'export async function startInstaller(){throw new Error("Payload fallback must not run")} export async function sendPackage(){throw new Error("Payload fallback must not run")}'}; return next(url,c) } })
const ip = '192.168.88.147', token = 'abcdef0123456789abcdef0123456789', revision = '0123456789abcdef', titleId = 'SLUS89993', cid = 'UP9000-SLUS89993_00-SLUS899930000001'
writeFileSync('.data/ps4-service-keys.json', JSON.stringify({[ip]:token}))
function pkg(values) {
 const keys=Buffer.concat(Object.keys(values).map(k=>Buffer.from(`${k}\0`))), data=Buffer.concat(Object.values(values).map(v=>Buffer.from(`${v}\0`))), count=Object.keys(values).length
 const sfo=Buffer.alloc(20+16*count+keys.length+data.length); sfo.writeUInt32LE(0x46535000); sfo.writeUInt32LE(20+count*16,8); sfo.writeUInt32LE(20+count*16+keys.length,12); sfo.writeUInt32LE(count,16)
 let key=0,value=0; Object.entries(values).forEach(([k,v],i)=>{const at=20+i*16,n=Buffer.byteLength(v)+1;sfo.writeUInt16LE(key,at);sfo.writeUInt16LE(0x204,at+2);sfo.writeUInt32LE(n,at+4);sfo.writeUInt32LE(n,at+8);sfo.writeUInt32LE(value,at+12);key+=Buffer.byteLength(k)+1;value+=n})
 keys.copy(sfo,20+count*16);data.copy(sfo,20+count*16+keys.length)
 const p=Buffer.alloc(8192);Buffer.from('7f434e54','hex').copy(p);p.writeUInt32BE(1,0x10);p.writeUInt32BE(128,0x18);Buffer.from(values.CONTENT_ID).copy(p,0x40);p.writeUInt32BE(0x1000,128);p.writeUInt32BE(256,144);p.writeUInt32BE(sfo.length,148);sfo.copy(p,256);return p
}
const base = pkg({TITLE:'Mario Collection',TITLE_ID:titleId,CONTENT_ID:cid,CATEGORY:'gd',APP_VER:'01.00'})
const updatePackage = pkg({TITLE:'PackegeFlowService',TITLE_ID:'PFLS00001',CONTENT_ID:'IV0000-PFLS00001_00-PACKAGEFLOWSRV00',CATEGORY:'gde',APP_VER:'01.20'})
const replacementPackage = pkg({TITLE:'PackageFlowService',TITLE_ID:'PFLS00001',CONTENT_ID:'IV0000-PFLS00001_00-PACKAGEFLOWSRV00',CATEGORY:'gde',APP_VER:'01.21'})
const updateHash = createHash('sha256').update(updatePackage).digest('hex')
writeFileSync('game.pkg',base)
const item={id:'one',title:'Mario Collection',titleId,contentId:cid,contentType:'PS4GD',size:base.length,path:resolve('game.pkg'),fileName:'game.pkg',libraryRoot:directory,sourceModifiedAt:1,installedAt:100,type:'Игра',installOrder:0,iconSize:0,icon:{offset:0,size:0},packageDigest:'0'.repeat(64)}
writeFileSync('.data/package-library.json',JSON.stringify({version:2,packages:[item],deliveries:{}}))
const app={titleId,title:'Mario Collection',version:'01.00',installed:true,protected:false}, part={id:'base',kind:'base',title:app.title,version:'01.00',contentId:cid,sizeBytes:base.length,storage:'internal',canRemove:true}
let removePosts=0, installPosts=0, controlPosts=0, updatePosts=0, removeState='running', removal, installedJob, controlResult, version='1.19'
let releaseDownloads=0
const response=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json'}})
globalThis.fetch=async(url,options={})=>{
 const u=new URL(url),path=u.pathname
 if(u.hostname==='api.github.com') return mode==='release' ? response({html_url:'https://github.com/demagoc3-cpu/playstation_installer/releases/tag/PKG',assets:[{name:'PackegeFlowService.pkg',size:updatePackage.length,digest:`sha256:${updateHash}`,browser_download_url:'https://github.com/demagoc3-cpu/playstation_installer/releases/download/PKG/PackegeFlowService.pkg'}]}) : response({message:'Not Found'},404)
 if(u.hostname==='github.com' && mode==='release') {releaseDownloads++;return new Response(updatePackage,{headers:{'Content-Type':'application/octet-stream'}})}
 assert.equal(u.port,'12801');assert.equal(options.redirect,'error')
 if(path==='/system/info') return response({service:'PackegeFlowService',environment:'ps4',pkgVersion:version})
 assert.equal(options.headers.Authorization,`Bearer ${token}`)
 if(path==='/apps/list') return response({service:'PackegeFlowService',appsApi:1,revision,complete:true,total:0,next:null,apps:[]})
 if(path.startsWith('/apps/title/')) return response({service:'PackegeFlowService',revision,complete:true,total:1,next:null,app,components:[part]})
 if(path.startsWith('/apps/runtime/')) return response({service:'PackegeFlowService',titleId:path.split('/').at(-1),running:false,appId:-1})
 if(path==='/apps/remove') { removePosts++;const b=JSON.parse(options.body);removal={service:'PackegeFlowService',...b,state:removeState,completed:0,total:1,error:0,errorHex:'0x00000000',pollError:0};return response(removal) }
 if(path.startsWith('/apps/operations/')) return response({...removal,state:removeState,completed:removeState==='removed'?1:0})
 if(path==='/install/jobs'||path==='/install/service-update') { if(path.endsWith('service-update'))updatePosts++;else installPosts++;const b=JSON.parse(options.body);installedJob={service:'PackegeFlowService',jobId:b.requestId,requestId:b.requestId,contentId:b.contentId,taskId:43,state:path.endsWith('service-update')?'downloading':'installed',totalBytes:b.size,downloadedBytes:b.size,downloadTotalBytes:b.size,error:0,errorHex:'0x00000000',pollError:0};return response(installedJob) }
 if(path.startsWith('/install/jobs/')) return response(installedJob)
 if(path==='/apps/control') {controlPosts++;const b=JSON.parse(options.body);controlResult={service:'PackegeFlowService',...b,state:b.action==='restart'?'pending':'running',appId:0x6000100d,error:0,errorHex:'0x00000000'};if(mode==='control')throw new Error('Reply lost');return response(controlResult)}
 if(path.startsWith('/apps/control/'))return response(controlResult)
 throw new Error(`Unexpected endpoint ${path}`)
}
const load=async n=>import(pathToFileURL(resolve(root,`server/utils/${n}.ts`)).href)
try {
 const maintenance=await load('console-maintenance'), control=await load('console-control'), updates=await load('service-updates')
 if(mode==='control') {
  const input={requestId:'11111111-1111-1111-1111-111111111111',titleId,action:'launch',expected:''}
  assert.equal((await control.submitConsoleControl(ip,input)).state,'running');assert.equal(controlPosts,1);await control.submitConsoleControl(ip,input);assert.equal(controlPosts,1)
  await assert.rejects(control.submitConsoleControl(ip,{...input,action:'stop',expected:'INVALID'}));assert.equal(controlPosts,1)
 } else if(mode==='release') {
  const fresh=await updates.latestServiceRelease('1.19');assert.equal(fresh.available,true);assert.equal(fresh.version,'1.20');assert.equal(releaseDownloads,1)
  assert.equal((await updates.latestServiceRelease('1.20')).available,false)
  assert.match((await updates.latestServiceRelease('1.22')).message,/новее опубликованной/)
  const staged=await updates.downloadLatestServicePackage('1.19');assert.equal(staged.version,'1.20');assert.equal(staged.id,fresh.artifactId);assert.equal(releaseDownloads,1)
 } else if(mode==='stage'||mode==='update'||mode==='manual_update'||mode==='recover_update'||mode==='replace_update') {
  await assert.rejects(updates.stageServicePackage(base)); await assert.rejects(updates.stageServicePackage(updatePackage,'0'.repeat(64)))
  const artifact=await updates.stageServicePackage(updatePackage);assert.equal(artifact.version,'1.20');assert.equal(updates.serviceArtifact(artifact.id).size,updatePackage.length);assert.throws(()=>updates.serviceArtifact('../bad'))
  assert.equal(updates.comparePkgVersions('1.20','1.19'),1);assert.equal((await updates.latestServiceRelease('1.19')).available,false)
  if(mode==='update'||mode==='manual_update'||mode==='recover_update'||mode==='replace_update') {
   const f=await updates.installServiceArtifact(ip,artifact.id,'http://192.168.88.10:3000');assert.equal(updatePosts,1);assert.equal(f.state,'installing');assert.match(f.input.url,/\/service-update\/manifest\/[0-9a-f-]+\.json$/)
   if(mode==='manual_update') {
    installedJob.state='failed';installedJob.errorHex='0x80990033';assert.equal((await maintenance.getMaintenance(ip)).state,'failed')
    version='1.20';const recovered=await maintenance.getMaintenance(ip);assert.equal(recovered.state,'completed');assert.equal(updatePosts,1);assert.equal(controlPosts,0)
   } else {
   installedJob.state='installed';const ready=await maintenance.getMaintenance(ip);assert.equal(ready.state,'restart_ready');assert.equal(updatePosts,1)
   const restarted=await maintenance.restartUpdatedService(ip);assert.equal(restarted.state,'restarting');assert.equal(controlPosts,1)
   assert.equal((await control.getConsoleControl(ip)).state,'pending');assert.equal((await maintenance.getMaintenance(ip)).state,'restarting')
   if(mode==='recover_update') {
    const recovered=await maintenance.reinstallMissingLauncher(ip);assert.equal(recovered.state,'installing');assert.equal(updatePosts,2)
    const previous=JSON.parse(readFileSync('.data/console-control.json'))[ip];assert.equal(previous.result.state,'failed')
    await assert.rejects(maintenance.reinstallMissingLauncher(ip));assert.equal(updatePosts,2)
    installedJob.state='installed';assert.equal((await maintenance.getMaintenance(ip)).state,'restart_ready')
    assert.equal((await maintenance.restartUpdatedService(ip)).state,'restarting');assert.equal(controlPosts,2)
   }
   if(mode==='replace_update') {
    const newer=await updates.stageServicePackage(replacementPackage)
    const replacement=await maintenance.replaceStalledUpdate(ip,newer.id,'http://192.168.88.10:3000');assert.equal(replacement.state,'installing');assert.equal(replacement.targetVersion,'1.21');assert.equal(updatePosts,2)
    assert.equal(JSON.parse(readFileSync('.data/console-control.json'))[ip].result.state,'failed')
    await assert.rejects(maintenance.replaceStalledUpdate(ip,newer.id,'http://192.168.88.10:3000'));assert.equal(updatePosts,2)
    installedJob.state='installed';assert.equal((await maintenance.getMaintenance(ip)).state,'restart_ready')
    assert.equal((await maintenance.restartUpdatedService(ip)).state,'restarting');assert.equal(controlPosts,2)
   }
   version=mode==='replace_update'?'1.21':'1.20';assert.equal((await control.getConsoleControl(ip)).state,'running');assert.equal((await maintenance.getMaintenance(ip)).state,'completed')
   assert.equal(updatePosts,['recover_update','replace_update'].includes(mode)?2:1);assert.equal(controlPosts,['recover_update','replace_update'].includes(mode)?2:1)
   }
  }
 } else {
  const plan=await maintenance.reinstallPlan(ip,'one');assert.equal(plan.details.app.titleId,titleId)
  await assert.rejects(maintenance.beginReinstall(ip,{packageId:'one',confirmTitleId:titleId,revision:'ffffffffffffffff',url:'http://192.168.88.10:3000/json/one.json'}));assert.equal(removePosts,0)
  let f=await maintenance.beginReinstall(ip,{packageId:'one',confirmTitleId:titleId,revision,url:'http://192.168.88.10:3000/json/one.json'});assert.equal(f.state,'removing');assert.equal(removePosts,1);assert.equal(installPosts,0)
  const queue=await load('installation-queue');assert.throws(()=>queue.startInstallationQueue({psIp:ip,packageIds:['one'],packageUrls:{one:'http://local/one'},transport:'service'}))
  if(mode==='recovery') {const stored=JSON.parse(readFileSync('.data/console-maintenance.json'));stored[ip].state='uncertain';writeFileSync('.data/console-maintenance.json',JSON.stringify(stored));await maintenance.getMaintenance(ip);assert.equal(removePosts,1)}
  removeState=mode==='partial'?'partial':'removed';f=await maintenance.getMaintenance(ip)
  if(mode==='partial'){assert.equal(f.state,'failed');assert.equal(installPosts,0)}
  else { for(let i=0;i<30&&f.state!=='completed';i++){await new Promise(r=>setTimeout(r,50));f=await maintenance.getMaintenance(ip)} assert.equal(f.state,'completed');assert.equal(installPosts,1);assert.equal(removePosts,1);await maintenance.getMaintenance(ip);assert.equal(installPosts,1) }
 }
 console.log(`PASS: ${mode}, real production workflows in isolated filesystem, scoped native requests, no payload fallback, no repeated writes`)
} finally { rmSync(directory,{recursive:true,force:true}) }
