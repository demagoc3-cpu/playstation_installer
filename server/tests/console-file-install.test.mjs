import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { createError } from 'h3'

function fixture(miniApp = false) {
  const data = Buffer.alloc(1024 * 1024), pairs = [ ['CATEGORY', miniApp ? 'gde' : 'al'], ['CONTENT_ID', 'EP0000-CUSA00001_00-TESTDLC000000000'], ['TITLE_ID', 'CUSA00001'], ['TITLE', 'Test DLC'], ['APP_VER', '01.00'] ]
  if (miniApp) pairs.push(['SYSTEM_VER', '00000000'])
  const keys = Buffer.from(pairs.map(([key]) => key + '\0').join('')), values = Buffer.from(pairs.map(([,value]) => value + '\0').join(''))
  const keyStart = 20 + pairs.length * 16, valueStart = keyStart + keys.length, sfo = Buffer.alloc(valueStart + values.length)
  sfo.writeUInt32LE(0x46535000); sfo.writeUInt32LE(keyStart, 8); sfo.writeUInt32LE(valueStart, 12); sfo.writeUInt32LE(pairs.length, 16)
  let k = 0, v = 0
  pairs.forEach(([key,value], index) => { const at = 20 + index * 16; sfo.writeUInt16LE(k, at); sfo.writeUInt16LE(0x204, at + 2); sfo.writeUInt32LE(value.length + 1, at + 4); sfo.writeUInt32LE(value.length + 1, at + 8); sfo.writeUInt32LE(v, at + 12); k += key.length + 1; v += value.length + 1 })
  keys.copy(sfo, keyStart); values.copy(sfo, valueStart)
  Buffer.from('7f434e54','hex').copy(data); data.writeUInt32BE(1,0x10); data.writeUInt32BE(0x1000,0x18); data.writeUInt32BE(miniApp ? 0x1a : 0x1c,0x74); data.writeBigUInt64BE(BigInt(data.length),0x430)
  Buffer.from(pairs[1][1]).copy(data,0x40); data.writeUInt32BE(0x1000,0x1000); data.writeUInt32BE(0x3000,0x1010); data.writeUInt32BE(sfo.length,0x1014); sfo.copy(data,0x3000)
  return data
}
test('local PKG: bounded metadata reads, size/revision/firmware gates, durable job recovery and cancel', async () => {
  const repo = process.cwd(), dir = mkdtempSync(resolve(tmpdir(),'pfs-local-test-')), bundle = resolve(repo,'node_modules/.cache/local-pkg-test.mjs')
  await build({ entryPoints:[resolve(repo,'server/utils/console-file-install.ts')], outfile:bundle, bundle:true, platform:'node', format:'esm', packages:'external' })
  const oldFetch = globalThis.fetch, ip = '10.1.10.32'
  let data = fixture(), miniAppSupported = false
  let revision = '0123456789abcdef', fileSize = data.length, available = 100 * 1024 ** 3, firmware = '12.50', requests = 0, readBytes = 0, current, loseReply = false, rejectRequest = false, absentJob = false, serviceReady = true
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers:{'content-type':'application/json'} })
  globalThis.createError = createError
  globalThis.fetch = async (url, init={}) => {
    const path = new URL(url).pathname, body = JSON.parse(init.body || '{}')
    if (path === '/install/capabilities' || path === '/install/session') return reply({ service:'PackegeFlowService',installApi:1,authentication:'bearer',ready:serviceReady,localInstall:true,contentTypes:miniAppSupported ? ['PS4GD','PS4AL','PS4GDE'] : ['PS4GD','PS4AL'],version:'0.10.0' })
    if (path === '/files/stat') return reply({ type:'file',size:fileSize,revision,mtime:1 })
    if (path === '/files/read') { const part = data.subarray(body.offset, body.offset + body.length); readBytes += part.length; return new Response(part, { headers:{'content-type':'application/octet-stream'} }) }
    if (path === '/system/info') return reply({ service:'PackegeFlowService',firmware:{ version:firmware } })
    if (path === '/storage') return reply({ service:'PackegeFlowService',volumes:[{id:'internal',path:'/user',available:true,availableBytes:available}] })
    if (path === '/install/jobs/active') return reply({active:false})
    if (path === '/install/local') {
      ++requests; assert.equal(body.url,'/data/Test DLC.pkg'); assert.equal(body.revision,revision); assert.equal(body.contentType,'PS4AL')
      if (rejectRequest) return reply({error:'local_package_changed_or_invalid',errorHex:'0x00000000'},500)
      current = {service:'PackegeFlowService',requestId:body.requestId,jobId:body.requestId,contentId:body.contentId,taskId:9,state:'downloading',totalBytes:data.length,downloadedBytes:0,downloadTotalBytes:0,error:0,errorHex:'0x00000000',pollError:0}
      if (loseReply) { loseReply = false; throw new Error('reply lost') }
      return reply(current)
    }
    if (path.startsWith('/install/jobs/')) {
      if (absentJob) return reply({error:'job_not_found',errorHex:'0x00000000'},404)
      if (path.endsWith('/cancel')) current = { ...current,state:'cancelled' }
      return reply(current)
    }
    throw new Error('Unexpected route ' + path)
  }
  process.chdir(dir); mkdirSync('.data'); writeFileSync('.data/ps4-service-keys.json',JSON.stringify({[ip]:'0123456789abcdef0123456789abcdef'}))
  try {
    const api = await import(bundle + '?v=' + Date.now())
    data=fixture(true)
    await assert.rejects(api.previewConsolePackage(ip,'/data/App.pkg'),/1\.69/)
    miniAppSupported=true
    const appPreview=await api.previewConsolePackage(ip,'/data/App.pkg')
    assert.equal(appPreview.contentType,'PS4GDE');assert.equal(appPreview.requiredFirmware,'0.00');assert.equal(appPreview.canInstall,true)
    data=fixture();readBytes=0
    serviceReady=false; await assert.rejects(api.previewConsolePackage(ip,'/data/Test DLC.pkg'),/API установки недоступен/); assert.equal(requests,0); serviceReady=true
    const p = await api.previewConsolePackage(ip,'/data/Test DLC.pkg')
    data.writeBigUInt64BE(0n,0x430); data.writeBigUInt64BE(0x2000n,0x20); data.writeBigUInt64BE(BigInt(data.length-0x2000),0x28);
    assert.equal((await api.previewConsolePackage(ip,'/data/Test DLC.pkg')).canInstall,true,'license-only PKG has no PFS package_size');
    data.writeBigUInt64BE(BigInt(data.length),0x430);
    assert.equal(p.title,'Test DLC'); assert.equal(p.canInstall,true); assert.ok(readBytes < data.length/4,'must not download entire PKG')
    await assert.rejects(api.previewConsolePackage(ip,'/user/app/CUSA00001/app.pkg'),/Выберите PKG/)
    fileSize--; await assert.rejects(api.previewConsolePackage(ip,'/data/Test DLC.pkg'),/загружен не полностью/); fileSize++
    firmware=''; assert.equal((await api.previewConsolePackage(ip,'/data/Test DLC.pkg')).canInstall,false); await assert.rejects(api.installConsolePackage(ip,'/data/Test DLC.pkg',revision),/прошивк/); assert.equal(requests,0); firmware='12.50'
    available=0; assert.equal((await api.previewConsolePackage(ip,'/data/Test DLC.pkg')).canInstall,false); await assert.rejects(api.installConsolePackage(ip,'/data/Test DLC.pkg',revision),/Недостаточно места/); available=100*1024**3
    await assert.rejects(api.installConsolePackage(ip,'/data/Test DLC.pkg','0000000000000000'),/изменился/); assert.equal(requests,0)
    loseReply=true; const accepted=await api.installConsolePackage(ip,'/data/Test DLC.pkg',revision); assert.equal(accepted.pending,true); assert.equal(requests,1)
    const restored=await api.listConsolePackageInstallations(ip); assert.equal(restored[0].pending,false); assert.equal(restored[0].job.state,'downloading'); assert.equal(requests,1)
    await assert.rejects(api.installConsolePackage(ip,'/data/Test DLC.pkg',revision),/Дождитесь установки/); assert.equal(requests,1)
    await api.cancelConsolePackageInstallation(ip,accepted.id); assert.equal((await api.listConsolePackageInstallations(ip))[0].job.state,'cancelled')
    const next=await api.installConsolePackage(ip,'/data/Test DLC.pkg',revision); current={...current,state:'installed'}; assert.equal((await api.listConsolePackageInstallations(ip))[0].job.state,'installed'); assert.notEqual(next.id,accepted.id)
    rejectRequest=true; const rejected=await api.installConsolePackage(ip,'/data/Test DLC.pkg',revision); assert.equal(rejected.pending,false); assert.equal(rejected.rejected,true); assert.match(rejected.error,/Локальный PKG/);
    absentJob=true; const history=await api.listConsolePackageInstallations(ip); assert.match(history[0].error,/Локальный PKG/); assert.doesNotMatch(history[0].error,/прежнее задание/);
    rejectRequest=false; absentJob=false; loseReply=true; const lost=await api.installConsolePackage(ip,'/data/Test DLC.pkg',revision); absentJob=true; const missing=(await api.listConsolePackageInstallations(ip)).find(j=>j.id===lost.id); assert.equal(missing.rejected,true); assert.equal(missing.error,'reply lost');
  } finally { globalThis.fetch=oldFetch; process.chdir(repo); rmSync(dir,{recursive:true,force:true}) }
})
