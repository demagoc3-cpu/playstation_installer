import { readMaintenance } from '../utils/maintenance-store';
import { advanceSelectedReinstall } from '../utils/selected-reinstallation';
export default defineNitroPlugin((nitro) => {
  const tick = () => {
    try {
      for (const [ip, flow] of Object.entries(readMaintenance()))
        if (flow.kind === 'selected-reinstall' && !['completed', 'failed'].includes(flow.state))
          void advanceSelectedReinstall(ip, flow).catch(() => {});
    } catch {
      /* Invalid ledger blocks new writes in maintenance-store. */
    }
  };
  const timer = setInterval(tick, 1500);
  timer.unref();
  tick();
  nitro.hooks.hook('close', () => clearInterval(timer));
});
