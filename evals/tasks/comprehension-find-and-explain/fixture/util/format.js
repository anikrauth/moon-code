// String formatting helpers. Unrelated to retry/backoff — present as a
// distractor file.
function padLeft(str, len, ch = ' ') {
  str = String(str);
  while (str.length < len) str = ch + str;
  return str;
}

module.exports = { padLeft };
