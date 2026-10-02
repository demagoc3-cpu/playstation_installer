export type FileAction = 'mkdir' | 'rename' | 'copy' | 'move' | 'trash' | 'restore' | 'replace' | 'delete' | 'purge'
export interface ConsoleFileStat { type: 'file' | 'directory' | 'link'; size: number; mtime: number; revision: string; identity?: string; writable: boolean }
export interface ConsoleFileJob {
  id: string; ip: string; action: FileAction; state: 'planning' | 'running' | 'paused' | 'completed' | 'failed'
  paths: string[]; destination?: string; current: string; done: number; total: number
  bytes: number; totalBytes: number; error: string; createdAt: string
}
export interface ConsoleTrashItem { id: string; ip: string; original: string; stored: string; createdAt: string; reason: 'deleted' | 'replaced' | 'moved'; restored?: boolean; purged?: boolean; purging?: string }
