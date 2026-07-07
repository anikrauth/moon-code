const { computeTotal } = require('./math');

function formatInvoice(items) {
  return `Invoice total: ${computeTotal(items)}`;
}

module.exports = { formatInvoice };
