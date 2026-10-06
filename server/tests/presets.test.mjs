import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
const root = process.cwd(), dir = mkdtempSync(resolve(tmpdir(), 'packageflow-presets-'))
process.chdir(dir); mkdirSync('.data'); writeFileSync('base.pkg', Buffer.alloc(1024))
registerHooks({ resolve(specifier, context, next) { try { return next(specifier, context) } catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) return next(`${specifier}.ts`, context); throw error } } })
const { createError } = await import(pathToFileURL(resolve(root,'node_modules/h3/dist/index.mjs'))); globalThis.createError = createError
const util = await import(pathToFileURL(resolve(root, 'server/utils/presets.ts')))
const base = { id:'base', title:'Racing Test', fileName:'base.pkg', size:1024,type:'Игра',titleId:'CUSA00001',contentId:'EP0000-CUSA00001_00-ABCDEFGHIJKLMNOP',contentType:'PS4GD',packageDigest:'a'.repeat(64),iconSize:0,installOrder:0,path:resolve('base.pkg'),libraryRoot:dir,sourceModifiedAt:1,icon:{offset:0,size:0} }
const patch = { ...base,id:'patch',title:'Update',fileName:'patch.pkg',type:'Патч',size:2048,installOrder:1,packageDigest:'b'.repeat(64),path:resolve('patch.pkg') }
writeFileSync('patch.pkg',Buffer.alloc(2048))
const saveLibrary = packages => writeFileSync('.data/package-library.json',JSON.stringify({version:2,packages,deliveries:{}}))
try {
  saveLibrary([base,patch])
  const preset = util.mutatePreset({action:'create',name:'Гонки',description:'Любимые гонки'})
  util.mutatePreset({action:'add',id:preset.id,packageIds:['base','patch','base']})
  assert.deepEqual(util.listPresets().items.map(p=>[p.games,p.files,p.size,p.missing]),[[1,2,3072,0]])
  assert.equal(util.presetPage(preset.id,{q:'Racing'}).items.length,2,'search includes the entire game branch')
  assert.equal(util.listPresets({q:'Любимые'}).items.length,1,'preset search includes description');assert.equal(util.presetPage(preset.id).description,'Любимые гонки');assert.equal(util.presetPage(preset.id).covers.length,1,'one thumbnail per game, not per DLC');
  const exportData=util.exportPresets(preset.id)
  assert.ok(!JSON.stringify(exportData).includes(dir),'no computer paths in portable exports')
  assert.deepEqual(util.presetSelection(preset.id).map(item=>item.id),['base','patch'])
  saveLibrary([{...base,id:'new-base',fileName:'renamed.pkg',path:resolve('base.pkg')},patch])
  assert.equal(util.presetSelection(preset.id)[0].id,'new-base','content digest survives rename and new IDs')
  saveLibrary([patch])
  assert.equal(util.presetPage(preset.id).missing,1)
  assert.throws(()=>util.presetSelection(preset.id),/отсутствует/)
  const page=util.presetPage(preset.id)
  assert.deepEqual(util.presetSelection(preset.id,[page.items.find(i=>i.available).key]).map(i=>i.id),['patch'])
  assert.throws(()=>util.presetSelection(preset.id,['untrusted-key']),/изменился/)
  const imported=util.importPresets(exportData)
  assert.notEqual(imported.ids[0],preset.id,'import never overwrites an existing preset')
  assert.equal(util.getPreset(imported.ids[0]).packages.length,2);assert.equal(util.getPreset(imported.ids[0]).description,'Любимые гонки');assert.throws(()=>util.mutatePreset({action:'rename',id:preset.id,name:'Changed',description:'x'.repeat(2001)}),/Описание/);assert.equal(util.getPreset(preset.id).name,'Гонки','invalid description does not partially rename');assert.equal(util.listPresets({pageSize:30}).items.length,2)
  assert.throws(()=>util.importPresets({...exportData,presets:[{name:'Bad',packages:[{...exportData.presets[0].packages[0],size:-1}]}]}),/Некоррект/)
  assert.equal(util.listPresets().total,2,'invalid import is atomic')
  util.mutatePreset({action:'remove',id:preset.id,keys:[page.items[0].key]})
  assert.equal(util.getPreset(preset.id).packages.length,1)
  util.mutatePreset({action:'rename',id:preset.id,name:'Гонки PS4'})
  assert.equal(util.getPreset(preset.id).name,'Гонки PS4')
  const many=Array.from({length:140},(_,i)=>({name:`Preset ${i}`,packages:[]}))
  util.importPresets({format:'packageflow-presets',version:1,presets:many})
  assert.equal(util.listPresets({pageSize:25}).items.length,25)
  assert.equal(util.listPresets({pageSize:25,page:6}).items.length,17)
  const ids=Array.from({length:6},(_,i)=>util.listPresets({pageSize:25,page:i+1}).items.map(p=>p.id)).flat()
  assert.equal(new Set(ids).size,142)
  util.deletePreset(preset.id);assert.throws(()=>util.getPreset(preset.id),/не найден/)
  console.log('Presets: portable identity, counts/size, full-branch search, missing files, selected installation, atomic import, editing, deletion and pagination: passed')
} finally { process.chdir(root);rmSync(dir,{recursive:true,force:true}) }
