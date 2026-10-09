import { test } from 'node:test'; import assert from 'node:assert/strict'; import { build } from 'esbuild'; import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join,resolve } from 'node:path'; import { pathToFileURL } from 'node:url'; import { createError } from 'h3';
test('WEB stops only pinned UI, persists before dispatch, and reconciles lost replies without replay',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pf-stop-web-')),old=process.env.PACKAGEFLOW_DATA_DIR,original=globalThis.fetch,data=join(dir,'data');mkdirSync(data);process.env.PACKAGEFLOW_DATA_DIR=data;globalThis.createError=createError
 try{
  const module=join(dir,'api.mjs');await build({stdin:{contents:"export * from './server/utils/console-profiles';export * from './server/utils/ps5-app-stop'",resolveDir:resolve('.')},outfile:module,bundle:true,platform:'node',format:'esm',logLevel:'silent'});const api=await import(pathToFileURL(module)),p=api.saveConsoleProfile({name:'Test',ip:'192.168.1.5',platform:'ps5'}).consoles[0]
  const pin={titleId:'PPSA95035',version:'01.000.034',metadataHash:'a'.repeat(64)};writeFileSync(join(data,'ps5-ui-release.json'),JSON.stringify(pin));writeFileSync(join(data,'ps5-service-keys.json'),JSON.stringify({[p.ip]:'b'.repeat(64)}))
  let stops=0,receipt,closed=false
  globalThis.fetch=async(url,options)=>{assert.equal(options.headers.Authorization,'Bearer '+'b'.repeat(64));const path=new URL(url).pathname;let body
   if(path==='/api/v1/app/status')body={available:true,canStop:true,running:!closed}
   else if(path==='/api/v1/app/stop/status'){assert.equal(options.method,'GET');assert.equal(options.headers['X-PackageFlow-UI-Title'],pin.titleId);body=receipt||{};if(receipt)body={...receipt,running:!closed}}
   else {assert.equal(path,'/api/v1/app/stop');assert.equal(options.method,'POST');stops++;assert.equal(options.headers['X-PackageFlow-UI-Title'],pin.titleId);assert.equal(options.headers['X-PackageFlow-UI-Metadata-Hash'],pin.metadataHash);const disk=JSON.parse(readFileSync(join(data,'consoles',p.id,'ps5-app-stop.json')));assert.equal(disk.state,'intent');receipt={requestId:disk.requestId,titleId:pin.titleId,state:'accepted',code:'0x00000000'};throw Error('reply lost')}
   return new Response(JSON.stringify(body),{status:200})
  }
  await assert.rejects(api.stopPs5App(p.id),/reply lost/);assert.equal(stops,1)
  await Promise.all([api.stopPs5App(p.id),api.stopPs5App(p.id)]);assert.equal(stops,1)
  closed=true;assert.equal((await api.ps5AppStopInfo(p.id)).flow.state,'closed');assert.equal(stops,1)
  writeFileSync(join(data,'consoles',p.id,'ps5-app-stop.json'),'broken');await assert.rejects(api.stopPs5App(p.id),/прочитать/);assert.equal(stops,1)
 }finally{globalThis.fetch=original;if(old===undefined)delete process.env.PACKAGEFLOW_DATA_DIR;else process.env.PACKAGEFLOW_DATA_DIR=old;rmSync(dir,{recursive:true,force:true})}
})
