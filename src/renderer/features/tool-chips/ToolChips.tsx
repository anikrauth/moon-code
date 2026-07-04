// @ts-nocheck
import React, { useState } from 'react';
import {
  Terminal, FileText, FilePlus, FilePenLine, FolderTree, Search,
  Puzzle, Bot, Brain, Plug, FileEdit, ChevronRight, Files,
} from 'lucide-react';

/* Internal tool names -> Claude-style friendly verbs. Unknown tools (MCP, etc.)
   fall back to their raw name. */
export const TOOL_LABELS: Record<string, string> = {
  run_command: 'Ran',
  read_file: 'Read',
  write_file: 'Wrote',
  edit_file: 'Updated',
  list_dir: 'Listed',
  glob_search: 'Searched',
  grep_search: 'Searched',
  skill: 'Skill',
  spawn_agent: 'Delegated',
  read_memory: 'Recalled',
  write_memory: 'Remembered',
};

const TOOL_ICONS: Record<string, any> = {
  run_command: Terminal,
  read_file: FileText,
  write_file: FilePlus,
  edit_file: FilePenLine,
  list_dir: FolderTree,
  glob_search: Search,
  grep_search: Search,
  skill: Puzzle,
  spawn_agent: Bot,
  read_memory: Brain,
  write_memory: Brain,
};

function iconFor(name: string) {
  if (TOOL_ICONS[name]) return TOOL_ICONS[name];
  if (name?.startsWith('mcp__')) return Plug;
  return FileEdit;
}

/* Concise, Claude-like one-liner for a tool result: counts where they read
   better than the first line, otherwise the first non-empty line. */
export function summarizeResult(name: string, result: string): string {
  const nonEmpty = result.split('\n').filter((l) => l.trim());
  if (name === 'read_file') {
    const n = result.replace(/\n$/, '').split('\n').length;
    return `Read ${n} line${n === 1 ? '' : 's'}`;
  }
  if (name === 'list_dir') {
    const n = nonEmpty.length;
    return `${n} item${n === 1 ? '' : 's'}`;
  }
  return (nonEmpty[0] ?? '').slice(0, 100) || '(no output)';
}

function baseName(p: string): string {
  return p.split('/').filter(Boolean).pop() || p;
}

/* A file-edit tool result (write_file/edit_file with fileChange) renders as a
   compact diff chip instead of a generic tool row. */
export function FileEditChip({ tool }: { tool: any }) {
  const fc = tool.fileChange;
  const label = TOOL_LABELS[tool.name] ?? 'Changed';
  return (
    <div className="tool-chip file-chip">
      <span className={`chip-status ${tool.result ? (String(tool.result).startsWith('Error') ? 'err' : 'ok') : 'pending'}`} />
      <FilePenLine size={13} className="chip-icon" />
      <span className="chip-verb">{label}</span>
      <span className="chip-file" title={fc.path}>{baseName(fc.path)}</span>
      <span className="chip-diffstat">
        {fc.adds > 0 && <span className="diff-add">+{fc.adds}</span>}
        {fc.dels > 0 && <span className="diff-del">−{fc.dels}</span>}
        {fc.adds === 0 && fc.dels === 0 && <span className="rp-muted">no change</span>}
      </span>
    </div>
  );
}

export function ToolChip({ tool }: { tool: any }) {
  const [expanded, setExpanded] = useState(false);

  if (tool.fileChange && (tool.name === 'write_file' || tool.name === 'edit_file')) {
    return <FileEditChip tool={tool} />;
  }

  let preview = '';
  try {
    const args = JSON.parse(tool.arguments ?? '{}');
    preview = String(args.command ?? args.filePath ?? args.dirPath ?? args.task ?? args.pattern ?? args.skill_id ?? args.name ?? '');
  } catch (e) {
    console.warn('[moon] tool arguments unparseable', e); // no preview
  }
  if (preview.length > 72) preview = `${preview.slice(0, 72)}…`;

  const label = TOOL_LABELS[tool.name] ?? tool.name;
  const Icon = iconFor(tool.name);
  const result = tool.result;
  const hasResult = tool.result != null;
  const isError = hasResult && (String(result).startsWith('Error:') || result === 'User denied permission for this action.' || result === 'aborted');
  const summary = hasResult ? summarizeResult(tool.name, result) : null;

  return (
    <div className="tool-chip-wrap">
      <div
        className={`tool-chip ${hasResult ? 'clickable' : ''}`}
        onClick={() => hasResult && setExpanded((e) => !e)}
        title={hasResult ? (expanded ? 'Collapse output' : 'Expand output') : undefined}
      >
        <span className={`chip-status ${hasResult ? (isError ? 'err' : 'ok') : 'pending'}`} />
        <Icon size={13} className="chip-icon" />
        {tool.agent && tool.agent !== 'main' && <span className="chip-agent">{tool.agent}</span>}
        <span className="chip-verb">{label}</span>
        {preview && <span className="chip-arg">{preview}</span>}
        {hasResult && <ChevronRight size={13} className={`chip-caret ${expanded ? 'open' : ''}`} />}
      </div>
      {summary != null && !expanded && (
        <div className={`chip-summary ${isError ? 'err' : ''}`}>{summary}</div>
      )}
      {expanded && hasResult && <pre className="chip-output">{result}</pre>}
    </div>
  );
}

/* End-of-turn "N files changed +A −D" summary. Aggregates fileChange payloads
   from a turn's tool calls, summing per unique path (a file edited twice sums).
   Derived at render time, so restored sessions get cards for free. */
export function TurnSummaryCard({ toolCalls }: { toolCalls: any[] }) {
  const byPath = new Map<string, { adds: number; dels: number; kind: string }>();
  for (const t of toolCalls ?? []) {
    const fc = t.fileChange;
    if (!fc) continue;
    const prev = byPath.get(fc.path);
    if (prev) { prev.adds += fc.adds; prev.dels += fc.dels; }
    else byPath.set(fc.path, { adds: fc.adds, dels: fc.dels, kind: fc.kind });
  }
  if (byPath.size === 0) return null;

  const files = [...byPath.entries()];
  const totals = files.reduce((a, [, v]) => ({ adds: a.adds + v.adds, dels: a.dels + v.dels }), { adds: 0, dels: 0 });

  return (
    <div className="turn-summary">
      <div className="ts-summary-head">
        <Files size={14} className="ts-summary-icon" />
        <span className="ts-summary-count">{files.length} file{files.length === 1 ? '' : 's'} changed</span>
        <span className="ts-summary-totals">
          <span className="diff-add">+{totals.adds}</span>
          <span className="diff-del">−{totals.dels}</span>
        </span>
      </div>
      <div className="ts-summary-files">
        {files.map(([p, v]) => (
          <div className="ts-summary-file" key={p} title={p}>
            <span className={`ts-file-kind ${v.kind}`}>{v.kind === 'create' ? 'new' : 'mod'}</span>
            <span className="ts-file-path">{p}</span>
            <span className="ts-file-stat">
              {v.adds > 0 && <span className="diff-add">+{v.adds}</span>}
              {v.dels > 0 && <span className="diff-del">−{v.dels}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
