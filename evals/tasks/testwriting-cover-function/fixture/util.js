// clamp(value, min, max) restricts value to the inclusive range [min, max].
// No test coverage yet — this is the target of the testwriting-cover-function
// eval task.
function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

module.exports = { clamp };
