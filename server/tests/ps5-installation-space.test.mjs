import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const temp = await mkdtemp(join(tmpdir(),'pf-space-')), file = join(temp,'api.mjs')
await build({stdin:{contents:"export * from './shared/ps5-installation-space'",resolveDir:resolve('.')},outfile:file,bundle:true,platform:'node',format:'esm',logLevel:'silent'})
const {requiredPs5InstallSpace:space} = await import(pathToFileURL(file).href)
test('only tested streaming Folder loses the second copy, with reserve and mixed queue isolation',()=>{
  const gib=1024**3, old={folder:{ready:true}}, current={folder:{ready:true,streamProtocol:'folder-stream-v2',storageCopies:1}}
  assert.equal(space([{size:100*gib,format:'folder'}],old),200*gib)
  assert.equal(space([{size:100*gib,format:'folder'}],current),102*gib)
  assert.equal(space([{size:100*gib,format:'folder',legacyFolder:true}],current),200*gib)
  assert.equal(space([{size:100*gib,format:'folder'},{size:10*gib,format:'pkg'},{size:5*gib,format:'ufs2'}],current),132*gib)
  assert.equal(space([],current),0)
})
