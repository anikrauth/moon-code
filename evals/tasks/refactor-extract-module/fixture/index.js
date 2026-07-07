// Cohesive helper block (string formatting) mixed in with the main logic
// below — task is to extract slugify/truncate into their own module and
// import them here, with no behavior change.
function slugify(str) {
  return String(str)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function truncate(str, maxLen) {
  const s = String(str);
  if (s.length <= maxLen) return s;
  return s.slice(0, Math.max(0, maxLen - 1)) + '…';
}

// Main logic: formats a title for display — truncates it to maxLen and
// returns both the display text and a URL-safe slug.
function formatTitle(str, maxLen) {
  const display = truncate(str, maxLen);
  const slug = slugify(str);
  return { display, slug };
}

module.exports = { formatTitle, slugify, truncate };
