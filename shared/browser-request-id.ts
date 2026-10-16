/** 128-bit command identity also works on LAN HTTP, where randomUUID is absent. */
export function browserRequestId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
