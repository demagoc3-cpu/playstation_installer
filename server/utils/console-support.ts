import { encode } from 'uqr'

/** The console receives the same public wallets and QR payloads as WEB. */
export function consoleSupport(config: { btc?: unknown; usdtTrc20?: unknown }) {
  const wallet = (value: unknown, bitcoin: boolean) => {
    const address = typeof value === 'string' && /^[A-Za-z0-9]{26,90}$/.test(value) ? value : ''
    if (!address) return { address: '', qr: '', size: 0 }
    const code = encode(bitcoin ? `bitcoin:${address}` : address, { border: 4 })
    if (code.size > 61) return { address: '', qr: '', size: 0 }
    return { address, qr: code.data.flat().map(bit => bit ? '1' : '0').join(''), size: code.size }
  }
  const btc = wallet(config.btc, true), usdt = wallet(config.usdtTrc20, false)
  return { schemaVersion: 1, btcAddress: btc.address, btcQr: btc.qr, btcSize: btc.size,
    usdtAddress: usdt.address, usdtQr: usdt.qr, usdtSize: usdt.size }
}
