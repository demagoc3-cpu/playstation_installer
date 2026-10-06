import { dataPath } from './data-path'
import { readJsonFile, writeJsonFile } from './json-store'
import { assertDesktopWritable } from './desktop-lifecycle'
import { getInstallationQueue, getInstallationHistory } from './installation-queue'
import { installationTaskCategory } from '../../shared/types/tasks'
const path = dataPath('task-visibility.json')
type Visibility = { version: 1; hidden: string[]; torrents: Record<string, string> }
export const taskVisibilityKey = (queueId: string | undefined, item: { packageId: string; state: string; completedAt?: number; installedAt?: number; bytesSent: number; detail: string }) => `${queueId}:${item.packageId}:${JSON.stringify([item.state, item.completedAt || item.installedAt || 0, item.bytesSent, item.detail])}`
export const getTaskVisibility = () => readJsonFile<Visibility>(path, { version: 1, hidden: [], torrents: {} })
export function clearFinishedTasks(torrents: unknown = [], ip?: string) {
  assertDesktopWritable()
  const state = getTaskVisibility(), hidden = new Set(state.hidden)
  let cleared = 0
  for (const queue of [getInstallationQueue(), ...getInstallationHistory()]) for (const item of queue.items) {
    if ((ip && queue.psIp !== ip) || !['completed', 'failed'].includes(installationTaskCategory(item.state))) continue
    const id = taskVisibilityKey(queue.id, item)
    if (!hidden.has(id)) { hidden.add(id); cleared++ }
  }
  if (Array.isArray(torrents)) for (const item of torrents) {
    if (!item || typeof item.hash !== 'string' || !/^[a-f0-9]{40,64}$/i.test(item.hash) || typeof item.state !== 'string' || typeof item.progress !== 'number') continue
    if (item.progress < 1 && !/error|missingFiles|unknown/i.test(item.state)) continue
    state.torrents[item.hash] = `${item.state}:${item.progress}`
  }
  // Keep queue records intact: the runner and installation confirmation use their indices.
  const retained = new Set([getInstallationQueue(), ...getInstallationHistory()].flatMap(queue => queue.items.map(item => taskVisibilityKey(queue.id, item))))
  state.hidden = [...hidden].filter(id => retained.has(id))
  writeJsonFile(path, state)
  return { cleared, hiddenTorrents: state.torrents }
}
