// @ts-nocheck
import { visit } from 'unist-util-visit';

/* Matches citations like "src/foo/bar.ts:123" in prose. Only walks `text`
   nodes, so content inside fenced/inline code (separate node types in the
   mdast tree) is never touched. */
const FILE_LINE_RE = /\b([\w.\-/]+\.[a-zA-Z]{1,10}):(\d+)\b/g;

/* Turns recognized file:line citations into links using a custom
   `moon-file://` scheme, resolved by the `a` component override in
   Markdown.tsx (never a real navigable URL). */
export default function remarkFileLinks() {
  return (tree: any) => {
    visit(tree, 'text', (node: any, index: number, parent: any) => {
      if (!parent || typeof index !== 'number') return;
      FILE_LINE_RE.lastIndex = 0;
      const text = node.value;
      if (!FILE_LINE_RE.test(text)) return;
      FILE_LINE_RE.lastIndex = 0;

      const children: any[] = [];
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = FILE_LINE_RE.exec(text))) {
        if (m.index > last) children.push({ type: 'text', value: text.slice(last, m.index) });
        const [full, path, line] = m;
        children.push({
          type: 'link',
          url: `moon-file://${path}#${line}`,
          children: [{ type: 'text', value: full }],
        });
        last = m.index + full.length;
      }
      if (last < text.length) children.push({ type: 'text', value: text.slice(last) });

      parent.children.splice(index, 1, ...children);
      return index + children.length;
    });
  };
}
