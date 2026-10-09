import { Ps5QueueFailure } from './ps5-queue-core'

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
  const buffers = [Buffer.alloc(chunkSize), Buffer.alloc(chunkSize)]
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
