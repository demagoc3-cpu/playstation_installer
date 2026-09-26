import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const indexPath = resolve(process.cwd(), '.data/torrent-library.json')
interface IndexedTorrent { indexedAt: number; packageIds: string[] }
interface Index { version: 1; hashes: Record<string, number | IndexedTorrent> }
const blank = (): Index => ({ version: 1, hashes: {} })

function readIndex() { try { const index = JSON.parse(readFileSync(indexPath, 'utf8')) as Index; return index.version === 1 ? index : blank() } catch { return blank() } }
function writeIndex(index: Index) { mkdirSync(dirname(indexPath), { recursive: true }); const temporary = `${indexPath}.${process.pid}.tmp`; writeFileSync(temporary, JSON.stringify(index)); renameSync(temporary, indexPath) }
export function wasTorrentIndexed(hash: string) { return Boolean(readIndex().hashes[hash]) }
/** Legacy timestamp-only entries are rebuilt once, then all later polls use these IDs. */
export function getIndexedTorrentPackageIds(hash: string) { const entry = readIndex().hashes[hash]; return typeof entry === 'object' ? entry.packageIds : undefined }
export function markTorrentIndexed(hash: string, packageIds: string[]) { const index = readIndex(); index.hashes[hash] = { indexedAt: Date.now(), packageIds: [...new Set(packageIds)] }; writeIndex(index) }
export function forgetTorrentIndex(hash: string) { if (!existsSync(indexPath)) return; const index = readIndex(); delete index.hashes[hash]; writeIndex(index) }
