// Defines computeTotal once; invoice.js, report.js, and cli.js all use it.
function computeTotal(items) {
  return items.reduce((a, b) => a + b, 0);
}

module.exports = { computeTotal };
