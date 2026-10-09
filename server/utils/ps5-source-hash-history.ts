import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createBLAKE3 } from 'hash-wasm'
import { dataPath } from './data-path'
import type { Ps5SourceHashCache } from './ps5-source-hash-cache'

async function document(path: string) {
  try { if ((await stat(path)).size > 16 * 1024 * 1024) return; return JSON.parse(await readFile(path, 'utf8')) } catch { return }
}
const hashValid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)

/** Reuse digests already saved by older WEB versions. Creation time is an
 * intentionally conservative cutoff; an uncertain historical source is rehashed. */
export async function seedPs5SourceHashHistory(cache: Ps5SourceHashCache, signal: AbortSignal, packageId?: string) {
  const root = dataPath('consoles')
  const directories = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const dir of directories) {
    signal.throwIfAborted()
    if (!dir.isDirectory()) continue
    const folder = join(root, dir.name), queue = await document(join(folder, 'ps5-installation-queue.json'))
    if (queue?.version !== 1 || !Array.isArray(queue.items) || !Array.isArray(queue.history)) continue
    const items = [...queue.items.map((item: any) => ({ ...item, checkedAfter: item?.createdAt || queue.createdAt })),
      ...queue.history.filter(Array.isArray).flat().map((item: any) => ({ ...item, checkedAfter: item?.createdAt }))]
      .filter(item => item.state === 'installed' && Number.isFinite(item.checkedAfter) && item.checkedAfter > 0)
    for (const item of items) {
      signal.throwIfAborted()
      const checkedAfter = item.checkedAfter
      if (packageId) {
        if (item.format === 'pkg' && item.packageId === packageId && typeof item.sourceStamp === 'string' && hashValid(item.hash)) cache.seed('.', { stamp: item.sourceStamp, hash: item.hash, checkedAfter })
        continue
      }
      if (item.format !== 'folder' || !/^[a-f0-9]{32}$/.test(item.transferId || '')) continue
      const plan = await document(join(folder, `${item.transferId}.folder-plan.json`))
      if (plan?.version !== 1 || plan.id !== item.transferId || typeof plan.root !== 'string' || resolve(plan.root) !== cache.scope || !Array.isArray(plan.entries) || plan.entries.length > 50000 || plan.manifestHash !== item.hash || !hashValid(plan.manifestHash)) continue
      // Check the saved manifest before accepting any of its per-file digests.
      if (plan.entries.some((e: any) => !e || typeof e.path !== 'string' || !e.path || e.path.length > 768 || typeof e.dir !== 'boolean' || !e.dir && (!hashValid(e.hash) || !/^[a-f0-9]{32}$/.test(e.id || '') || typeof e.stamp !== 'string' || !Number.isSafeInteger(e.size) || e.size < 0))) continue
      const manifest = `PF_FOLDER1 ${plan.title} ${plan.content} ${plan.appVersion} ${plan.total} ${plan.entries.length}\n` + plan.entries.map((e: any) => e.dir ? `D ${Buffer.from(e.path).toString('hex')}\n` : `F ${e.id} ${e.hash} ${e.size} ${Buffer.from(e.path).toString('hex')}\n`).join('')
      const hasher = await createBLAKE3(256); hasher.update(manifest)
      if (hasher.digest('hex') !== plan.manifestHash) continue
      for (const entry of plan.entries) if (!entry.dir) cache.seed(entry.path, { stamp: entry.stamp, hash: entry.hash, checkedAfter })
    }
  }
}
