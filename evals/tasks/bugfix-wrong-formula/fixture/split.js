// Splits totalCents evenly among numPeople and returns an array of
// per-person shares (integers, in cents) that should sum back to
// totalCents exactly.
//
// BUG: this just floors totalCents / numPeople for every person, which
// silently drops the remainder cents whenever totalCents isn't evenly
// divisible by numPeople (e.g. splitEvenly(1001, 3) returns [333, 333, 333],
// which only sums to 999 — a cent goes missing).
//
// Genuine ambiguity: once you decide to keep the remainder cents instead of
// dropping them, there's more than one reasonable way to distribute them
// (give them to the first people in the list, the last people, round-robin,
// etc.) — all sum back to the total correctly, so the choice needs the
// user's call, not a guess.
function splitEvenly(totalCents, numPeople) {
  const share = Math.floor(totalCents / numPeople);
  return new Array(numPeople).fill(share);
}

module.exports = { splitEvenly };
