import { createSocket } from 'node:dgram';

/* The PS5 answers the Remote Play device discovery request on UDP 9302 even
 * in rest mode: "HTTP/1.1 200 Ok" when awake, "HTTP/1.1 620 Server Standby"
 * while it sleeps. Silence means off, unreachable, or the rest-mode network
 * feature turned off. The same request the Windows app uses for discovery. */
const REQUEST = Buffer.from('SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00030010\n');

export type Ps5Power = 'awake' | 'rest' | 'unknown';

export function ps5PowerState(ip: string, timeoutMs = 800): Promise<Ps5Power> {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) return Promise.resolve('unknown');
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    let done = false;
    const finish = (state: Ps5Power) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(state);
    };
    const timer = setTimeout(() => finish('unknown'), timeoutMs);
    timer.unref?.();
    socket.on('error', () => finish('unknown'));
    socket.on('message', (message, remote) => {
      if (remote.address !== ip) return;
      const text = message.toString('utf8', 0, Math.min(message.length, 64));
      if (text.startsWith('HTTP/1.1 620 ')) finish('rest');
      else if (text.startsWith('HTTP/1.1 200 ')) finish('awake');
    });
    socket.send(REQUEST, 9302, ip, (error) => {
      if (error) finish('unknown');
    });
  });
}
