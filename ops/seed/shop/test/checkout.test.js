const test = require('node:test')
const assert = require('node:assert')
const { total, discount } = require('../checkout.js')

test('adds tax for Canada', () => assert.strictEqual(total([{ price: 10, qty: 2 }], 'CA'), 22.6))
test('refuses countries the shop does not ship to', () => assert.throws(() => total([], 'FR'), /ERR_NO_SHIP/))
test('HALF halves the amount', () => assert.strictEqual(discount(40, 'HALF'), 20))
