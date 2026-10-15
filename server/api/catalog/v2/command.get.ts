import { ps5AppCommand } from '../../../utils/ps5-app-commands';
export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store');
  const q = getQuery(event);
  return ps5AppCommand(q.consoleId, q.id);
});
