import { ps5ServiceStartInfo } from '../../utils/ps5-service-start';
export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store');
  return ps5ServiceStartInfo(getQuery(event).consoleId);
});
