import assert from 'node:assert/strict'
import { test } from 'node:test'
import { consoleSelection, consoleQueueTasks } from '../utils/console-app-data.ts'
import type { LocalPackage } from '../utils/package-library.ts'
const pkg = (id: string, contentType: string, order: number) => ({ id, titleId: 'CUSA00001', fileName: id+'.pkg', contentType, installOrder: order, size: 1000, type: contentType === 'PS4GD' ? 'Игра' : 'DLC' } as LocalPackage)
const library = [pkg('dlc', 'PS4AC', 2), pkg('base', 'PS4GD', 0), {...pkg('other', 'PS4GD', 0), titleId: 'CUSA00002'}]
test('native selections resolve the full game on WEB, preserve installation order and reject other game IDs', () => {
  assert.deepEqual(consoleSelection(library, 'CUSA00001', 'all').map(p => p.id), ['base','dlc'])
  assert.deepEqual(consoleSelection(library, 'CUSA00001', 'selected', ['dlc','base','dlc']).map(p => p.id), ['base','dlc'])
  assert.throws(() => consoleSelection(library, 'CUSA00001', 'selected', ['other']))
  assert.throws(() => consoleSelection(library, 'CUSA00001', 'selected', []))
  assert.deepEqual(consoleSelection(library, 'CUSA00001', 'reinstall').map(p => p.id), ['base','dlc'])
  assert.deepEqual(consoleSelection(library, 'CUSA00001', 'dlc').map(p => p.id), ['dlc'])
  assert.deepEqual(consoleSelection(library, 'CUSA00001', 'patches'), [])
  assert.deepEqual(consoleSelection([{...pkg('patch','PS4GP',1),type:'Патч'}, {...pkg('bp','PS4GP',1),type:'Бэкпорт'}, ...library], 'CUSA00001', 'patches').map(p => p.id), ['bp','patch'])
  const large = Array.from({length:150}, (_,i) => pkg(String(i), 'PS4AC', 2))
  assert.equal(consoleSelection(large, 'CUSA00001', 'all').length, 150)
})
test('PS4 snapshots preserve unconfirmed/errors and cannot turn full transfer into installation success', () => {
  const queue = {psIp:'10.1.10.32', items:[{packageId:'dlc',state:'unconfirmed',detail:'Not verified',bytesSent:1000}]}
  const task = consoleQueueTasks(queue, queue.psIp, library)[0]!
  assert.equal(task.progress,99);assert.equal(task.state,'unconfirmed');assert.equal(task.detail,'Not verified')
  queue.items[0]!.state='installed';assert.equal(consoleQueueTasks(queue, queue.psIp, library)[0]!.progress,100)
  assert.deepEqual(consoleQueueTasks(queue,'10.1.10.33',library),[])
})
test('old package IDs remain selectable and keep task labels after duplicate sources are grouped', () => {
  const packages = [{ ...pkg('base', 'PS4GD', 0), title: 'Same game', sourceIds: ['base', 'old-mount'] }]
  assert.deepEqual(consoleSelection(packages, 'CUSA00001', 'selected', ['old-mount', 'base']).map(p => p.id), ['base'])
  const tasks = consoleQueueTasks({ psIp: '10.1.10.32', items: [{ packageId: 'old-mount', state: 'receiving', detail: 'Active', bytesSent: 500 }] }, '10.1.10.32', packages)
  assert.equal(tasks[0]!.id, 'old-mount', 'cancellation still targets the accepted job ID')
  assert.match(tasks[0]!.title, /Same game/)
  assert.equal(tasks[0]!.progress, 50)
})
