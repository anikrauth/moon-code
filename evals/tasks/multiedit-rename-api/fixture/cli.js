#!/usr/bin/env node
const { computeTotal } = require('./math');
const { formatInvoice } = require('./invoice');
const { formatReport } = require('./report');

const numbers = process.argv.slice(2).map(Number);

console.log(`Direct total: ${computeTotal(numbers)}`);
console.log(formatInvoice(numbers));
console.log(formatReport(numbers));
