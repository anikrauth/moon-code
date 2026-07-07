// Sums the first n elements of arr. Has an off-by-one bug: the loop
// condition should be `i < n`, not `i <= n`, so it reads past the
// intended range.
function sumFirstN(arr, n) {
  let total = 0;
  for (let i = 0; i <= n; i++) {
    total += arr[i];
  }
  return total;
}

module.exports = { sumFirstN };
