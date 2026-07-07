const { computeTotal } = require('./math');

function formatReport(items) {
  return `Report total: ${computeTotal(items)}`;
}

module.exports = { formatReport };
