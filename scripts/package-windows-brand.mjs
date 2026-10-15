import { readFileSync, writeFileSync } from 'node:fs';
import { encode } from 'uqr';
const source = readFileSync(new URL('../nuxt.config.ts', import.meta.url), 'utf8');
const address = (key, env) =>
  process.env[env] ?? source.match(new RegExp(`${key}:\\s*'([^']*)'`))?.[1] ?? '';
const wallets = [
  {
    Name: 'Bitcoin (BTC)',
    Network: 'Bitcoin',
    Address: address('btc', 'NUXT_PUBLIC_DONATION_BTC'),
  },
  {
    Name: 'Tether (USDT)',
    Network: 'Tron · TRC20',
    Address: address('usdtTrc20', 'NUXT_PUBLIC_DONATION_USDT_TRC20'),
  },
].filter((wallet) => wallet.Address);
for (const wallet of wallets)
  wallet.Qr = encode(
    wallet.Name.startsWith('Bitcoin') ? `bitcoin:${wallet.Address}` : wallet.Address,
  ).data.map((row) => row.map(Boolean));
writeFileSync(
  new URL('../apps/windows-launcher/PackageFlow.Windows/Assets/donations.json', import.meta.url),
  JSON.stringify(wallets),
);
