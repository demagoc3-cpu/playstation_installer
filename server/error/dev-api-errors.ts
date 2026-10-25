import type { H3Error, H3Event } from 'h3';
import { getRequestHeader, getRequestURL, send, setResponseHeader, setResponseStatus } from 'h3';

/* Development server only (registered from nuxt.config). Nitro 2.13's dev error
 * handler maps every error's stack through the 6 MB server source map and never
 * frees the parser, so after about 40 errors each one prints "unreachable" from
 * source-map's WebAssembly. Expected API refusals (4xx) need no stack: answer
 * them with the same JSON fields here. Server errors and HTML pages keep the
 * default handlers. Production builds do not include this file. */
export default function devApiErrors(error: H3Error, event: H3Event) {
  const status = error.statusCode;
  if (
    !status ||
    status >= 500 ||
    !event.path.startsWith('/api/') ||
    getRequestHeader(event, 'accept')?.includes('text/html')
  )
    return;
  setResponseHeader(event, 'content-type', 'application/json');
  setResponseHeader(event, 'cache-control', 'no-cache');
  setResponseStatus(event, status, error.statusMessage);
  return send(
    event,
    JSON.stringify(
      {
        error: true,
        url: getRequestURL(event),
        statusCode: status,
        statusMessage: error.statusMessage,
        message: error.message,
        data: error.data,
      },
      null,
      2,
    ),
  );
}
