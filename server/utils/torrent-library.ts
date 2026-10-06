import { dataPath } from './data-path'
import { existsSync, readFileSync } from 'node:fs'

import { writeJsonFile } from './json-store'

const indexPath = dataPath('torrent-library.json')
interface IndexedTorrent { indexedAt: number; packageIds: string[] }
interface Index { version: 1; hashes: Record<string, number | IndexedTorrent>; autoInstalled?: Record<string, number> }
const blank = (): Index => ({ version: 1, hashes: {} })

function readIndex() { try { const index = JSON.parse(readFileSync(indexPath, 'utf8')) as Index; return index.version === 1 ? index : blank() } catch { return blank() } }
function writeIndex(index: Index) { writeJsonFile(indexPath, index) }
export function wasTorrentIndexed(hash: string) { return Boolean(readIndex().hashes[hash]) }
/** Legacy timestamp-only entries are rebuilt once, then all later polls use these IDs. */
export function getIndexedTorrentPackageIds(hash: string) { const entry = readIndex().hashes[hash]; return typeof entry === 'object' ? entry.packageIds : undefined }
export function markTorrentIndexed(hash: string, packageIds: string[]) { const index = readIndex(); index.hashes[hash] = { indexedAt: Date.now(), packageIds: [...new Set(packageIds)] }; writeIndex(index) }
export function forgetTorrentIndex(hash: string) { if (!existsSync(indexPath)) return; const index = readIndex(); delete index.hashes[hash]; delete index.autoInstalled?.[hash]; writeIndex(index) }
/** Torrents whose automatic installation was already started (or given up on), so it runs only once. */
export function wasAutoInstallHandled(hash: string) { return Boolean(readIndex().autoInstalled?.[hash]) }
export function markAutoInstallHandled(hash: string) { const index = readIndex(); (index.autoInstalled ||= {})[hash] = Date.now(); writeIndex(index) }
export function clearAutoInstallHandled(hash: string) { if (!existsSync(indexPath)) return; const index = readIndex(); if (!index.autoInstalled?.[hash]) return; delete index.autoInstalled[hash]; writeIndex(index) }
