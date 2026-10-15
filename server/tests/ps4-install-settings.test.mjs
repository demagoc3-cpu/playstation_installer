import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { parse, compileScript } from '@vue/compiler-sfc'

test('optional PS4 PKG requirements default off, persist, reject malformed settings and never bypass PS5 requirements', async () => {
  const work=mkdtempSync(join(tmpdir(),'pf-ps4-settings-')),previous=process.env.PACKAGEFLOW_DATA_DIR
  process.env.PACKAGEFLOW_DATA_DIR=work
  try {
    const bundle=join(work,'settings.mjs')
    await build({stdin:{contents:`export * from './server/utils/ps4-install-settings';export * from './shared/device-eligibility'`,resolveDir:resolve('.')},outfile:bundle,bundle:true,platform:'node',format:'esm',logLevel:'silent'})
    const api=await import(pathToFileURL(bundle).href)
    assert.deepEqual(api.getPs4InstallSettings(),{verifyPkgBeforeSend:false})
    for(const value of [null,{},true,{verifyPkgBeforeSend:'false'}])assert.throws(()=>api.savePs4InstallSettings(value),{statusCode:400})
    api.savePs4InstallSettings({verifyPkgBeforeSend:true})
    assert.equal(api.getPs4InstallSettings().verifyPkgBeforeSend,true)
    const restarted=await import(`${pathToFileURL(bundle).href}?restart=1`)
    assert.equal(restarted.getPs4InstallSettings().verifyPkgBeforeSend,true)
    api.savePs4InstallSettings({verifyPkgBeforeSend:false})
    assert.equal(restarted.getPs4InstallSettings().verifyPkgBeforeSend,false)
    const profile={platform:'ps4',online:true,paired:false,transport:'payload',firmware:'5.05',capabilities:{formats:['pkg'],installPs4:true,installPs5:false}}
    const pkg={platform:'ps4',format:'pkg',contentType:'PS4GP',size:1,requiredFirmware:'12.50'}
    assert.equal(api.deviceInstallReason(profile,[pkg],0,false),'')
    assert.match(api.deviceInstallReason(profile,[pkg],0,true),/12.50/)
    const ps5={...profile,platform:'ps5',paired:true,transport:'service',firmware:'13.20',capabilities:{formats:['pkg'],installPs4:true,installPs5:true}}
    assert.match(api.deviceInstallReason(ps5,[{...pkg,platform:'ps5',contentType:'PS5GD',requiredFirmware:'13.60'}],0,false),/13.60/)
    writeFileSync(join(work,'ps4-install-settings.json'),'{invalid')
    assert.equal(api.getPs4InstallSettings().verifyPkgBeforeSend,false)
  } finally {if(previous===undefined)delete process.env.PACKAGEFLOW_DATA_DIR;else process.env.PACKAGEFLOW_DATA_DIR=previous;rmSync(work,{recursive:true,force:true})}
})

test('settings glass card loads and saves the real preference; a failed save keeps its last value', async () => {
  const work=mkdtempSync(join(tmpdir(),'pf-ps4-settings-view-')),old=globalThis.ps4SettingsFixture,callbacks=[],calls=[]
  const {descriptor}=parse(readFileSync('app/components/Ps4InstallSettings.vue','utf8'))
  const script=compileScript(descriptor,{id:'ps4-settings'}).content
  const contents=`import {ref} from 'vue';const useAppLocale=()=>({t:s=>s});const onMounted=fn=>globalThis.ps4SettingsFixture.mount(fn);const $fetch=(url,options)=>globalThis.ps4SettingsFixture.fetch(url,options);\n${script}`
  let rejected=false
  globalThis.ps4SettingsFixture={mount:fn=>callbacks.push(fn),fetch:async(url,options)=>{calls.push({url,options});if(rejected)throw new Error('offline');return{verifyPkgBeforeSend:options?.body.verifyPkgBeforeSend ?? false}}}
  try {
    const outfile=join(work,'view.cjs');await build({stdin:{contents,loader:'ts',resolveDir:resolve('app/components')},outfile,bundle:true,platform:'node',format:'cjs',logLevel:'silent'})
    const view=createRequire(import.meta.url)(outfile).default.setup({}, {expose(){}})
    assert.equal(view.loaded.value,false);await callbacks[0]();assert.equal(view.loaded.value,true);assert.equal(view.enabled.value,false)
    const event={target:{checked:true}};await view.save(event);assert.equal(view.enabled.value,true)
    assert.deepEqual(calls[1],{url:'/api/ps4/install-settings',options:{method:'POST',body:{verifyPkgBeforeSend:true}}})
    rejected=true;event.target.checked=false;await view.save(event)
    assert.equal(view.enabled.value,true);assert.equal(event.target.checked,true);assert.equal(view.busy.value,false)
  } finally {globalThis.ps4SettingsFixture=old;rmSync(work,{recursive:true,force:true})}
})
