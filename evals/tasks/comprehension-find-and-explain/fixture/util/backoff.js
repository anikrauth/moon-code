// Computes exponential backoff delay, capped at a maximum.
// The cap is deliberately odd-looking: 2733ms (not a round number),
// to test whether the agent actually reads this file rather than
// guessing a "typical" value like 1000 or 30000.
function backoffDelayMs(attempt) {
  const base = 100;
  const cap = 2733;
  const raw = base * Math.pow(2, attempt);
  return Math.min(raw, cap);
}

module.exports = { backoffDelayMs };
