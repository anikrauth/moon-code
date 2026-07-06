// Minimal leveled logger used elsewhere in this fixture repo.
function log(level, ...args) {
  // eslint-disable-next-line no-console
  console.log(`[${level}]`, ...args);
}

module.exports = { log };
