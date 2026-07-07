#!/usr/bin/env node
// Tiny CLI: reports the count and total of numeric args.
// Currently only prints human-readable text. Task: add a `--json` flag
// that switches output to JSON with keys { count, total }.

const args = process.argv.slice(2);
const numbers = args.filter((a) => a !== '--json').map(Number);
const count = numbers.length;
const total = numbers.reduce((a, b) => a + b, 0);

console.log(`count=${count} total=${total}`);
