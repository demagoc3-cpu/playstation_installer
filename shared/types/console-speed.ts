export type SpeedMode = 'latency' | 'upload' | 'download' | 'disk'
export interface ConsoleSpeedResult { mode: SpeedMode; bytes: number; elapsedMs: number; bytesPerSecond?: number; latencyMinMs?: number; latencyMedianMs?: number; latencyMaxMs?: number; writeMs?: number; syncMs?: number; cleanup?: boolean; receivePipeline?: boolean }
export interface ConsoleSpeedJob { id: string; consoleId: string; ip: string; state: 'running' | 'completed' | 'cancelled' | 'failed'; current?: SpeedMode; size: number; startedAt: number; finishedAt?: number; results: ConsoleSpeedResult[]; error?: string }
