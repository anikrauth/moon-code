// @ts-nocheck
/* Utilities for streaming markdown: split a document into stable blocks so the
   renderer can memoize everything but the tail, and stabilize the tail so
   half-streamed fences/emphasis don't flash as raw markup. */

const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})/;

/* Split on blank lines, keeping fence contents (which may contain blank
   lines) inside one block. Invariant: blocks.join('') === md — the split
   never adds or drops characters, separators stay attached to their block. */
export function splitMarkdownBlocks(md: string): string[] {
    if (md === '') return [];
    const lines = md.split('\n');
    const blocks: string[] = [];
    let current = '';
    let fence: string | null = null; // opening fence marker (``` or ~~~...) while inside one

    const flush = () => {
        if (current !== '') blocks.push(current);
        current = '';
    };

    for (let i = 0; i < lines.length; i++) {
        // Re-attach the newline that split() consumed (not after the last line).
        const line = lines[i] + (i < lines.length - 1 ? '\n' : '');
        const fenceMatch = FENCE_RE.exec(lines[i]);
        if (fence) {
            current += line;
            // Closing fence: same char, at least as long as the opener.
            if (fenceMatch && fenceMatch[2][0] === fence[0] && fenceMatch[2].length >= fence.length) {
                fence = null;
            }
            continue;
        }
        if (fenceMatch) {
            current += line;
            fence = fenceMatch[2];
            continue;
        }
        if (lines[i].trim() === '') {
            // Blank line ends a block; keep the separator on the finished block.
            current += line;
            flush();
            continue;
        }
        current += line;
    }
    flush();
    return blocks;
}

/* Display-only stabilizer for the streaming tail block: close an open code
   fence so partial code renders inside a <pre> instead of as raw backticks,
   and strip a trailing half-open emphasis/inline-code marker. Never applied
   to settled content. */
export function closeDanglingFence(block: string): string {
    const lines = block.split('\n');
    let fence: string | null = null;
    for (const l of lines) {
        const m = FENCE_RE.exec(l);
        if (!m) continue;
        if (fence && m[2][0] === fence[0] && m[2].length >= fence.length) fence = null;
        else if (!fence) fence = m[2];
    }
    if (fence) {
        return block + (block.endsWith('\n') ? '' : '\n') + fence;
    }
    // Trailing lone marker (streaming just emitted `**` or `` ` ``): drop it
    // from display until the rest arrives. Never touch a fence line — its
    // backticks are the closing delimiter, not an inline marker.
    if (FENCE_RE.test(lines[lines.length - 1])) return block;
    return block.replace(/(\*{1,2}|_{1,2}|`)$/, '');
}
