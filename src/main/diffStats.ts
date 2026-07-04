// @ts-nocheck
// Line-level diff counts for file-edit chips + per-turn "N files changed" cards.
// LCS on lines gives git-numstat-comparable adds/dels. Capped so a huge
// write can't trigger O(n*m) blowup — above the cap we fall back to the
// coarse line-delta (still monotonic, just not minimal).
const LCS_CELL_CAP = 4_000_000; // n*m ceiling (~2000x2000 lines)

export function computeLineDiff(oldText, newText) {
    const oldStr = oldText == null ? '' : String(oldText);
    const newStr = newText == null ? '' : String(newText);
    if (oldStr === newStr) return { adds: 0, dels: 0 };

    const oldLines = splitLines(oldStr);
    const newLines = splitLines(newStr);
    if (oldStr === '') return { adds: newLines.length, dels: 0 };
    if (newStr === '') return { adds: 0, dels: oldLines.length };

    const n = oldLines.length;
    const m = newLines.length;
    if (n * m > LCS_CELL_CAP) {
        return { adds: Math.max(0, m - n), dels: Math.max(0, n - m) };
    }

    // LCS length via rolling 1-D DP.
    let prev = new Array(m + 1).fill(0);
    let curr = new Array(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
        const oi = oldLines[i - 1];
        for (let j = 1; j <= m; j++) {
            if (oi === newLines[j - 1]) curr[j] = prev[j - 1] + 1;
            else curr[j] = prev[j] >= curr[j - 1] ? prev[j] : curr[j - 1];
        }
        const t = prev; prev = curr; curr = t;
    }
    const lcs = prev[m];
    return { adds: m - lcs, dels: n - lcs };
}

function splitLines(s) {
    const lines = s.split('\n');
    // A trailing newline yields a phantom empty final element; drop it so
    // "a\nb\n" counts as 2 lines, matching git.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
}
