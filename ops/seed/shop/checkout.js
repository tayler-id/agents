// What an order costs, and whether the shop can ship it.
const SHIPPABLE = ['US', 'CA', 'MX']
const TAX = { US: 0.07, CA: 0.13, MX: 0.16 }

function total(items, country) {
  if (!SHIPPABLE.includes(country)) throw new Error(`ERR_NO_SHIP: cannot ship to ${country}`)
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0)
  return Math.round(subtotal * (1 + TAX[country]) * 100) / 100
}

function discount(amount, code) {
  if (code === 'HALF') return amount / 2
  if (code === 'TENOFF') return amount - 10
  return amount
}

module.exports = { total, discount }
