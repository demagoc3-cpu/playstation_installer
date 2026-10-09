/** Live throughput of acknowledged bytes. Never persisted or restored as a rate. */
export class TransferSpeed {
  private samples: Array<{ time: number; bytes: number }> = []
  constructor(private clock: () => number = () => performance.now()) {}
  reset() { this.samples = [] }
  observe(bytes: number) {
    const time = this.clock(), last = this.samples.at(-1)
    if (!Number.isSafeInteger(bytes) || bytes < 0) { this.reset(); return }
    if (last && (bytes < last.bytes || time < last.time || time - last.time > 5000)) this.reset()
    if (this.samples.at(-1)?.bytes === bytes) return
    this.samples.push({ time, bytes })
    // Keep the point immediately before the rolling five-second window.
    while (this.samples.length > 2 && this.samples[1]!.time < time - 5000) this.samples.shift()
  }
  read() {
    const time = this.clock(), first = this.samples[0], last = this.samples.at(-1)
    if (!first || !last || time < last.time || time - first.time < 1000) return undefined
    if (time - last.time > 5000) return 0
    return (last.bytes - first.bytes) * 1000 / (time - first.time)
  }
}
