import { createHash } from 'node:crypto';
import { readFileSync, statSync, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { dataPath } from './data-path';
import { writeDurableJson } from './durable-json';
import { ps5SourceHash, ps5SourceStamp } from './ps5-source-hash';

type FileStat = Stats;
type Entry = { key: string; stamp: string; hash: string };
type LegacyEntry = { stamp: string; hash: string; checkedAfter: number };
const digestValid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
// ctime catches same-size edits even when the old mtime has been restored.
const cacheStamp = (s: FileStat) => `${ps5SourceStamp(s)}:${s.ctimeMs}:${s.birthtimeMs}:${s.dev}`;

/** Local WEB data, shared by consoles and independent of transfer IDs. */
export class Ps5SourceHashCache {
  private entries = new Map<string, Entry>();
  private dirty = new Map<string, Entry>();
  private legacy = new Map<string, LegacyEntry>();
  private lastFlush = Date.now();
  private writable = true;
  readonly scope: string;
  readonly path: string;
  constructor(scope: string) {
    this.scope = resolve(scope);
    this.path = dataPath(
      `source-hash-cache/${createHash('sha256').update(this.scope).digest('hex')}.json`,
    );
    this.entries = this.load();
  }
  private load() {
    try {
      if (statSync(this.path).size > 16 * 1024 * 1024) return new Map<string, Entry>();
      const doc = JSON.parse(readFileSync(this.path, 'utf8'));
      if (
        doc.version !== 1 ||
        doc.algorithm !== 'blake3-256' ||
        doc.scope !== this.scope ||
        !Array.isArray(doc.entries) ||
        doc.entries.length > 50000
      )
        return new Map<string, Entry>();
      if (
        doc.entries.some(
          (e: any) =>
            !e ||
            typeof e.key !== 'string' ||
            !e.key ||
            e.key.length > 1024 ||
            typeof e.stamp !== 'string' ||
            !e.stamp ||
            e.stamp.length > 256 ||
            !digestValid(e.hash),
        )
      )
        return new Map<string, Entry>();
      return new Map<string, Entry>(doc.entries.map((e: Entry) => [e.key, e]));
    } catch {
      return new Map<string, Entry>();
    } // A missing/corrupt cache means rehash, never failure or a guessed digest.
  }
  seed(key: string, value: LegacyEntry) {
    if (
      digestValid(value.hash) &&
      typeof value.stamp === 'string' &&
      Number.isFinite(value.checkedAfter) &&
      value.checkedAfter > 0 &&
      (!this.legacy.has(key) || this.legacy.get(key)!.checkedAfter < value.checkedAfter)
    )
      this.legacy.set(key, value);
  }
  get(key: string, stat: FileStat) {
    const entry = this.entries.get(key);
    if (entry?.stamp === cacheStamp(stat)) return entry.hash;
    const old = this.legacy.get(key);
    // A historical stamp lacks ctime: accept it only if the source hasn't
    // changed since BEFORE that installation began, not merely since import.
    if (
      old &&
      old.stamp === ps5SourceStamp(stat) &&
      stat.ctimeMs <= old.checkedAfter &&
      stat.birthtimeMs <= old.checkedAfter
    ) {
      this.put(key, stat, old.hash);
      return old.hash;
    }
  }
  put(key: string, stat: FileStat, hash: string) {
    if (!digestValid(hash)) throw new Error('Invalid source digest');
    const stamp = cacheStamp(stat),
      previous = this.entries.get(key);
    if (previous?.stamp === stamp && previous.hash === hash) return;
    const entry = { key, stamp, hash };
    this.entries.set(key, entry);
    this.dirty.set(key, entry);
    if (this.dirty.size >= 64 || Date.now() - this.lastFlush >= 1000) this.flush();
  }
  flush() {
    if (!this.dirty.size || !this.writable) return;
    try {
      // Other consoles may have saved hashes while this job was running.
      const merged = this.load();
      for (const [key, entry] of this.dirty) merged.set(key, entry);
      while (merged.size > 50000) merged.delete(merged.keys().next().value!);
      writeDurableJson(this.path, {
        version: 1,
        algorithm: 'blake3-256',
        scope: this.scope,
        entries: [...merged.values()],
      });
      this.entries = merged;
      this.dirty.clear();
      this.lastFlush = Date.now();
    } catch {
      this.writable = false;
      console.warn('WEB could not save source hash cache; source verification remains enabled');
    }
  }
}

export async function cachedPs5SourceHash(
  cache: Ps5SourceHashCache,
  key: string,
  file: FileHandle,
  size: number,
  identity: string,
  signal: AbortSignal,
  progress: (bytes: number) => void,
) {
  signal.throwIfAborted();
  const before = await file.stat();
  if (!before.isFile() || before.size !== size || ps5SourceStamp(before) !== identity)
    throw new Error('Исходный файл изменился перед проверкой');
  let hash = cache.get(key, before);
  if (!hash) hash = await ps5SourceHash(file, size, identity, signal, progress);
  const after = await file.stat();
  if (cacheStamp(after) !== cacheStamp(before))
    throw new Error('Исходный файл изменился во время проверки');
  signal.throwIfAborted();
  cache.put(key, after, hash);
  progress(size);
  return hash;
}
