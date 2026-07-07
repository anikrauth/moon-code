// Handles outbound HTTP calls with retry semantics.
const { backoffDelayMs } = require('./util/backoff');

async function fetchWithRetry(fetchFn, attempt = 0) {
  try {
    return await fetchFn();
  } catch (err) {
    const delay = backoffDelayMs(attempt);
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (attempt >= 5) throw err;
    return fetchWithRetry(fetchFn, attempt + 1);
  }
}

module.exports = { fetchWithRetry };
