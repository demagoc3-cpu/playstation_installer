import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encode } from 'uqr'
import { consoleSupport } from '../utils/console-support.ts'

test('console receives the WEB wallets, with BTC URI and raw TRC20 address', () => {
  const btc = '17jXaJmM4jki1gwQmzo4ep9U4Sb6iiZXWG', usdtTrc20 = 'TRMH7kJxydeBxjbyu2FRmraoDzkx6mRa9v'
  const data = consoleSupport({ btc, usdtTrc20 })
  assert.equal(data.btcAddress, btc); assert.equal(data.usdtAddress, usdtTrc20)
  for (const [payload, bits, size] of [[`bitcoin:${btc}`, data.btcQr, data.btcSize], [usdtTrc20, data.usdtQr, data.usdtSize]] as const) {
    const expected = encode(payload, { border: 4 })
    assert.equal(size, expected.size); assert.equal(bits.length, size * size)
    assert.equal(bits, expected.data.flat().map(bit => bit ? '1' : '0').join(''))
    assert.ok(size <= 61)
  }
  assert.equal(consoleSupport({}).btcSize, 0)
  assert.equal(consoleSupport({ btc: '<script>' }).btcAddress, '')
  assert.equal(consoleSupport({ btc, usdtTrc20: '' }).usdtQr, '')
})
