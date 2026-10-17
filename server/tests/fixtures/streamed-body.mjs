import assert from 'node:assert/strict';

/** Package bodies are streamed to the PS5 with an exact Content-Length (never
 * chunked). Fixtures read them back as one Buffer. */
export async function streamedBody(options) {
  if (!(options?.body instanceof ReadableStream)) return options;
  assert.equal(options.duplex, 'half');
  const parts = [];
  for await (const part of options.body) parts.push(Buffer.from(part));
  const body = Buffer.concat(parts);
  assert.equal(Number(options.headers['Content-Length']), body.length);
  return { ...options, body };
}
