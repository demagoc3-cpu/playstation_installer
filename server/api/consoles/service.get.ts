import { ps5ServiceStatus } from '../../utils/ps5-service-control';

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store');
  const query = getQuery(event);
  return ps5ServiceStatus(String(query.consoleId || ''), {
    checkRelease: query.release === '1',
  });
});
