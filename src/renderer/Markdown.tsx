// @ts-nocheck
import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js';
import { splitMarkdownBlocks, closeDanglingFence } from '../shared/markdownBlocks';

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

const MD_COMPONENTS = {
  code: CodeRenderer,
  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
};

/* One block per component so React.memo skips re-parsing/re-highlighting
   settled blocks: during a stream only the tail block's string changes. */
const Block = React.memo(function Block({ md }: { md: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
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
