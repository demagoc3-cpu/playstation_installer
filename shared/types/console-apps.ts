export interface ConsoleApp { titleId: string; title: string; version: string; installed: boolean; protected: boolean; iconUrl?: string; fallbackIconUrl?: string }
export interface ConsoleComponent { id: string; kind: 'base' | 'patch' | 'dlc'; title: string; version: string; contentId: string; sizeBytes: number; storage: 'internal' | 'external' | 'mixed'; canRemove: boolean }
export interface ConsoleCatalog { apps: ConsoleApp[]; complete: boolean; revision: string }
export interface ConsoleDetails { app: ConsoleApp; components: ConsoleComponent[]; complete: boolean; revision: string }
export type RemovalKind = 'game' | 'patch' | 'dlc' | 'dlcs'
export interface RemoveInput { requestId: string; titleId: string; kind: RemovalKind; componentId: string; revision: string; confirmTitleId: string }
export type RemoveState = 'queued' | 'running' | 'verifying' | 'removed' | 'failed' | 'partial' | 'uncertain'
export interface RemoveOperation { requestId: string; titleId: string; kind: RemovalKind; componentId: string; state: RemoveState; completed: number; total: number; error: number; errorHex: string; pollError: number; message?: string; pending?: boolean }
