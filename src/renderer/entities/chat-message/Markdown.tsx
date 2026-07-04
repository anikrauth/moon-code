// @ts-nocheck
import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from '@shared/lib/highlight';
import { splitMarkdownBlocks, closeDanglingFence } from '@shared/lib/markdownBlocks';
import remarkFileLinks from './remarkFileLinks';
const REMARK_PLUGINS = [remarkGfm, remarkFileLinks];

/* Fenced code blocks reuse the same highlight.js path as the JSON-UI CodeBlock
   (uiRegistry.tsx) so highlighting is consistent across both render paths. */
function CodeRenderer({ inline, className, children }: any) {
  const text = String(children ?? '').replace(/\n$/, '');
  if (inline) return <code className="md-inline-code">{children}</code>;
  const lang = /language-(\w+)/.exec(className ?? '')?.[1];
  const highlighted = lang && hljs.getLanguage(lang)
    ? hljs.highlight(text, { language: lang }).value
    : hljs.highlightAuto(text).value;
  return (
    <pre className="md-pre">
      <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
    </pre>
  );
}

/* Set by App.tsx whenever the active workspace changes. Read at click time
   only (not a React prop) so Block's memoization stays keyed on `md` alone —
   file-link clicks are rare enough that a module-level var beats threading a
   workspace prop through every memoized block. */
let activeWorkspace: string | null = null;
export function setLinkWorkspace(ws: string | null) { activeWorkspace = ws; }

/* remarkFileLinks rewrites recognized `path:line` citations into
   moon-file://path#line links; open those via IPC instead of navigating. */
function LinkRenderer({ href, children }: any) {
  if (href?.startsWith('moon-file://')) {
    const rest = href.slice('moon-file://'.length);
    const hash = rest.indexOf('#');
    const filePath = hash === -1 ? rest : rest.slice(0, hash);
    const parsedLine = hash === -1 ? NaN : Number.parseInt(rest.slice(hash + 1), 10);
    const line = Number.isFinite(parsedLine) && parsedLine > 0 ? parsedLine : undefined;
    if (!filePath) return <span>{children}</span>;
    return (
      <a
        href="#"
        className="md-file-link"
        onClick={(e) => {
          e.preventDefault();
          if (activeWorkspace) window.electron?.openFile?.(activeWorkspace, filePath, line);
        }}
      >
        {children}
      </a>
    );
  }
  return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
}

const MD_COMPONENTS = {
  code: CodeRenderer,
  a: LinkRenderer,
};

/* One block per component so React.memo skips re-parsing/re-highlighting
   settled blocks: during a stream only the tail block's string changes. */
const Block = React.memo(function Block({ md }: { md: string }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MD_COMPONENTS}>
      {md}
    </ReactMarkdown>
  );
});

export default function Markdown({ children, streaming = false }: { children: string; streaming?: boolean }) {
  const blocks = useMemo(() => splitMarkdownBlocks(children ?? ''), [children]);
  const last = blocks.length - 1;
  return (
    <div className="md-body">
      {blocks.map((b, i) => (
        // Index keys are stable here: blocks only append or extend at the tail.
        <Block key={i} md={streaming && i === last ? closeDanglingFence(b) : b} />
      ))}
    </div>
  );
}
