import { Ps5QueueFailure } from './ps5-queue-core'

/** Only the exact, hardware-qualified batch limit enables the pipelined route.
 * Older services keep their bounded chunk protocol. */
export function ps5TransferProtocol(reply: { chunkMax?: unknown; batchMax?: unknown }) {
  if (reply.batchMax === 16 * 1024 * 1024 || reply.batchMax === 32 * 1024 * 1024 || reply.batchMax === 64 * 1024 * 1024 || reply.batchMax === 128 * 1024 * 1024) return { path: '/api/v1/transfers/batch' as const, size: reply.batchMax }
  const max = reply.chunkMax
  const size = typeof max === 'number' && Number.isInteger(max) && max >= 262144 && max <= 4194304 && (max & (max - 1)) === 0 ? max : 262144
  return { path: '/api/v1/transfers/chunk' as const, size }
}

/** Read one chunk ahead while PS5 receives/fsyncs the current chunk. The next
 * POST still waits for its predecessor's durable ACK; buffers never overlap. */
export async function ps5SendChunks(input: {
  read: (buffer: Buffer, position: number) => Promise<number>; size: number; offset: number; chunkSize: number; signal: AbortSignal
  validateSource: () => Promise<boolean>
  send: (offset: number, bytes: Uint8Array) => Promise<void>
  progress: (offset: number) => void
}) {
  const { size, chunkSize, signal } = input
  signal.throwIfAborted()
  if (input.offset >= size) return
  const bufferSize = Math.min(chunkSize, size - input.offset)
  const buffers = [Buffer.alloc(bufferSize), Buffer.alloc(bufferSize)]
  let offset = input.offset, index = 0
  // Catch immediately: an early read failure must not become an unhandled rejection
  // while the current network request is in flight.
  const read = (position: number, buffer: Buffer) => input.read(buffer.subarray(0, Math.min(chunkSize, size - position)), position)
    .then(result => ({ result, error: undefined }), error => ({ result: undefined, error }))
  let pending = read(offset, buffers[index]!)
  try {
    while (offset < size) {
      signal.throwIfAborted()
      const part = await pending
      if (part.error) throw part.error
      const count = part.result!
      if (count !== Math.min(chunkSize, size - offset) || !await input.validateSource()) throw new Ps5QueueFailure('Исходный файл изменился во время передачи')
      signal.throwIfAborted()
      const next = offset + count, current = buffers[index]!
      index = 1 - index
      if (next < size) pending = read(next, buffers[index]!)
      await input.send(offset, current.subarray(0, count))
      signal.throwIfAborted()
      offset = next; input.progress(offset)
    }
  } finally { await pending }
}
