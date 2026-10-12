import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createError } from 'h3'

test('multi-device preflight, concurrent real PS4 queues, receipts, destination-specific cancellation and installed badges',async()=>{
  const work=mkdtempSync(join(tmpdir(),'pf-devices-')),previous=process.env.PACKAGEFLOW_DATA_DIR,oldIp=process.env.PACKAGEFLOW_HOST_IP,oldFetch=globalThis.fetch,oldError=globalThis.createError
  const data=join(work,'data');mkdirSync(data);process.env.PACKAGEFLOW_DATA_DIR=data;process.env.PACKAGEFLOW_HOST_IP='192.168.1.2';globalThis.createError=createError
  try {
    const bundle=join(work,'test.mjs')
    await build({stdin:{contents:`export * from './server/utils/device-installation';export * from './server/utils/console-profiles';export * from './server/utils/installation-queue';export * from './server/utils/package-library';export * from './shared/device-eligibility';export * from './server/utils/task-visibility'`,resolveDir:resolve('.')},outfile:bundle,bundle:true,platform:'node',format:'esm',logLevel:'silent'})
    const api=await import(pathToFileURL(bundle).href)
    const one=api.saveConsoleProfile({name:'Living room',ip:'192.168.1.4',platform:'ps4',model:'Slim'}).consoles[0]
    const two=api.saveConsoleProfile({name:'Workshop',ip:'192.168.1.6',platform:'ps4',model:'Pro'}).consoles[1]
    const five=api.saveConsoleProfile({name:'PS5',ip:'192.168.1.5',platform:'ps5'}).consoles[2]
    const source=join(work,'test.pkg');writeFileSync(source,Buffer.alloc(131072))
    const base={id:'z-base',platform:'ps4',format:'pkg',title:'Own homebrew',titleId:'CUSA95001',contentId:'IV0000-CUSA95001_00-PACKAGEFLOWUI001',contentType:'PS4GD',size:131072,type:'Игра',installOrder:0,requiredFirmware:'5.05',fileName:'base.pkg',path:source,libraryRoot:work,sourceModifiedAt:1,iconSize:0,icon:{offset:0,size:0},packageDigest:'1'.repeat(64)}
    const patch={...base,packageDigest:'2'.repeat(64),id:'a-patch',type:'Патч',installOrder:1,contentType:'PS4GP',appVersion:'1.01',fileName:'patch.pkg'}
    const future={...base,id:'ps5-pkg',platform:'ps5',titleId:'PPSA95001',contentType:'PS5GD',contentId:'IV0000-PPSA95001_00-PACKAGEFLOWUI001'}
    writeFileSync(join(data,'package-library.json'),JSON.stringify({version:2,packages:[base,patch,future],deliveries:{}}))
    writeFileSync(join(data,'ps4-service-keys.json'),JSON.stringify({[one.ip]:'a'.repeat(32),[two.ip]:'b'.repeat(32)}))
    writeFileSync(join(data,'ps5-service-keys.json'),JSON.stringify({[five.ip]:'c'.repeat(64)}))
    const cap={service:'PackegeFlowService',version:'0.4.0',installApi:1,authentication:'bearer',ready:true,contentTypes:['PS4GD','PS4GP'],error:0,errorHex:'0x00000000'}
    const jobs=new Map(),posts=[];let offline=false
    const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}})
    globalThis.fetch=async(url,options={})=>{
      const address=new URL(url),ip=address.hostname,path=address.pathname
      if(address.port==='9090'&&path==='/status')return response({status:'ready'})
      if(ip===two.ip&&offline)throw new Error('offline')
      if(ip===five.ip){if(path==='/health')return response({apiVersion:'v1',firmwareRead:true,firmwareRaw:'0x13600007',serviceReport:{service:'PackageFlowService-PS5',version:'0.1.3',consoleVerified:true}});assert.equal(options.headers.Authorization,`Bearer ${'c'.repeat(64)}`);if(path==='/api/v1/system')return response({service:'PackageFlowService-PS5',storageRead:true,freeBytes:500000000,totalBytes:1000000000});return response({service:'PackageFlowService-PS5',capabilities:{installPs4Pkg:false,installPs5Content:false,backgroundService:false}})}
      assert.ok([one.ip,two.ip].includes(ip),'captured recipients only')
      if(path.startsWith('/apps/title/'))return response({service:cap.service,complete:true,revision:'a'.repeat(16),app:{titleId:path.split('/')[3],installed:false},total:0,next:null,components:[]})
      if(path==='/ping')return response({...cap,status:'ok'})
      if(path==='/system/info')return response({...cap,environment:'ps4',firmware:{version:'12.50'},model:{name:'Slim',family:'Slim'},hen:{}})
      if(path==='/storage')return response({...cap,volumes:[{id:'internal',path:'/user',available:true,totalBytes:1000000000,freeBytes:900000000,availableBytes:900000000,usedBytes:100000000}]})
      if(path==='/status')return response({...cap,status:'ok',uptimeSeconds:1,requests:1,replies:1})
      if(path==='/install/capabilities')return response(cap)
      assert.equal(options.headers.Authorization,`Bearer ${ip===one.ip?'a'.repeat(32):'b'.repeat(32)}`)
      if(path==='/install/session')return response(cap)
      if(path==='/install/jobs/active')return response({service:cap.service,active:false})
      if(path==='/install/jobs'&&options.method==='POST'){
        const body=JSON.parse(options.body);const address=new URL(body.url);assert.ok(address.pathname.startsWith(`/ps4/manifest/${ip}/`));assert.ok(body.url.endsWith('.json'));assert.equal(address.search,'');posts.push({ip,titleId:body.titleId,contentType:body.contentType})
        const job={service:cap.service,jobId:body.requestId,requestId:body.requestId,contentId:body.contentId,taskId:42,state:'downloading',totalBytes:131072,downloadedBytes:1,downloadTotalBytes:131072,error:0,errorHex:'0x00000000',pollError:0};jobs.set(ip,job);return response(job)
      }
      const job=jobs.get(ip);assert.ok(job&&path.startsWith(`/install/jobs/${job.jobId}`),path)
      if(path.endsWith('/cancel'))job.state='cancelled'
      return response(job)
    }
    const until=async check=>{const end=Date.now()+8000;while(!check()){assert.ok(Date.now()<end,'worker timeout');await new Promise(resolve=>setTimeout(resolve,20))}}
    const preview=await api.previewDeviceInstall({packageIds:['a-patch','z-base']})
    assert.equal(preview.files,2);assert.equal(preview.devices.filter(item=>item.eligible).length,2);assert.equal(preview.devices.find(item=>item.profile.id===five.id).eligible,false)
    assert.equal(preview.devices[0].profile.freeBytes,900000000);assert.equal(preview.devices[2].profile.freeBytes,500000000)
    assert.match(preview.devices[2].reason,/готовность установки PS5/)
    const mixed=await api.previewDeviceInstall({librarySelection:{scope:'all',platform:'all'}})
    assert.equal(mixed.files,3);assert.equal(mixed.devices.some(item=>item.eligible),false,'whole selection, no silent platform filtering')
    assert.match(api.deviceInstallReason({...preview.devices[0].profile,freeBytes:1},[base],base.size),/места/)
    api.saveConsoleProfile({...one,transport:'payload'})
    const mixedTransport=await api.previewDeviceInstall({packageIds:['z-base']},[one.id,two.id])
    assert.equal(mixedTransport.devices.every(device=>!device.eligible),true,'mixed PyLoader/service batch must be refused for every selected PS4')
    assert.ok(mixedTransport.devices.every(device=>/параллельной установки/.test(device.reason)))
    const denied=await api.installDeviceBatch('4'.repeat(32),{packageIds:['z-base']},[one.id,two.id],'localhost:3000')
    assert.equal(denied.results.every(result=>result.state==='failed'),true)
    assert.equal(posts.length,0,'mixed transports cannot start one console before rejecting another')
    api.saveConsoleProfile({...two,transport:'payload'})
    const twoPayloads=await api.previewDeviceInstall({packageIds:['z-base']},[one.id,two.id])
    assert.equal(twoPayloads.devices.every(device=>!device.eligible),true)
    api.saveConsoleProfile({...one,transport:'service'});api.saveConsoleProfile({...two,transport:'service'})
    offline=true
    const rejected=await api.installDeviceBatch('1'.repeat(32),{packageIds:['z-base']},[one.id,two.id],'localhost:3000')
    assert.equal(rejected.results.every(result=>result.state==='failed'),true);assert.equal(posts.length,0,'preflight sends nothing if a selected recipient is offline')
    offline=false
    const body={packageIds:['a-patch','z-base']},recipients=[one.id,two.id]
    const [started,repeated]=await Promise.all([api.installDeviceBatch('2'.repeat(32),body,recipients,'localhost:3000'),api.installDeviceBatch('2'.repeat(32),body,recipients,'localhost:3000')])
    assert.deepEqual(started,repeated);assert.equal(started.results.every(result=>result.state==='queued'),true);assert.notEqual(started.results[0].queueId,started.results[1].queueId)
    assert.equal('fingerprint' in started,false)
    await until(()=>posts.length===2)
    assert.equal(posts.every(post=>post.contentType==='PS4GD'),true,'base first even when request IDs sort patch before game')
    await api.installDeviceBatch('2'.repeat(32),body,recipients,'localhost:3000');assert.equal(posts.length,2,'no duplicate dispatch on repeated POST')
    await assert.rejects(api.installDeviceBatch('2'.repeat(32),{packageIds:['z-base']},recipients,'localhost:3000'),/другой установки/)
    api.selectConsoleProfile(five.id)
    api.cancelGameInstallation(api.getInstallationQueue(one.ip).id,one.ip,base.titleId)
    await until(()=>api.getInstallationQueue(one.ip).items.every(item=>item.state==='cancelled'))
    assert.equal(api.getInstallationQueue(two.ip).status,'running');assert.equal(jobs.get(two.ip).state,'downloading')
    api.markPackageInstalled(base.id,true,two.ip)
    const summary=api.deviceActivities([base.id]);assert.equal(summary.find(item=>item.consoleId===two.id).installedPackageIds.length,0,'a local mark is never a live installed badge');assert.equal(summary.find(item=>item.consoleId===one.id).installedPackageIds.length,0)
    assert.equal(api.deviceActivities().flatMap(item=>item.installedPackageIds).length,0,'summary does not load whole installed library into response')
    api.cancelInstallationQueue(two.ip);await until(()=>api.getInstallationQueue(two.ip).status==='cancelled')
    api.clearFinishedTasks([],one.ip);const hidden=api.getTaskVisibility().hidden
    api.clearFinishedTorrentTasks([{hash:'a'.repeat(40),state:'stoppedUP',progress:1}]);assert.deepEqual(api.getTaskVisibility().hidden,hidden,'torrent cleanup preserves device history')
    // Simulate WEB restart after claim: never replay an ambiguous batch.
    const old={id:'3'.repeat(32),fingerprint:JSON.parse(readFileSync(join(data,'installation-batches',`${'2'.repeat(32)}.json`),'utf8')).fingerprint,state:'pending',createdAt:1,results:[{consoleId:one.id,name:one.name,state:'pending',message:''}]}
    writeFileSync(join(data,'installation-batches',`${old.id}.json`),JSON.stringify(old))
    const recovered=await api.installDeviceBatch(old.id,body,recipients,'localhost:3000');assert.equal(recovered.results[0].state,'uncertain');assert.equal(posts.length,2)
  } finally { globalThis.fetch=oldFetch;globalThis.createError=oldError;if(previous===undefined)delete process.env.PACKAGEFLOW_DATA_DIR;else process.env.PACKAGEFLOW_DATA_DIR=previous;if(oldIp===undefined)delete process.env.PACKAGEFLOW_HOST_IP;else process.env.PACKAGEFLOW_HOST_IP=oldIp;rmSync(work,{recursive:true,force:true}) }
})
