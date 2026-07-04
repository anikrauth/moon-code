// @ts-nocheck
import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Send,
  Square,
  Puzzle,
  Paperclip,
  Globe,
} from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface McpServer {
  id: string;
  name: string;
  status: 'connected' | 'disconnected' | 'connecting';
  tools?: number;
}

interface RichInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
  placeholder?: string;
  onAddSkill: () => void;
  /** Connected MCP servers */
  mcpServers: McpServer[];
  onConnectMcp: () => void;
  /** Model profiles */
  profiles: { id: string; name: string }[];
  activeProfileId: string | null;
  onSelectProfile: (id: string) => void;
  busy?: boolean;
  onStop?: () => void;
  commands?: { name: string; description: string; run: (arg?: string) => void }[];
  onUnknownCommand?: (name: string, arg?: string) => void;
  /** Context window fullness (null until there is a conversation) */
  contextInfo?: {
    lastInputTokens: number;
    lastOutputTokens: number;
    contextWindow: number;
    pct: number;
    estimated: boolean;
  } | null;
  /** Active model capabilities (gates toolbar affordances) */
  capabilities?: { tools: boolean; vision: boolean };
}

const fmtTok = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : `${n}`);

/* Rank a command name against a lowercased query. Higher = better match;
   -1 means no match. Empty query matches everything (base score). */
function scoreCommand(query: string, name: string): number {
  if (query === '') return 0;
  if (name === query) return 1000;
  if (name.startsWith(query)) return 800;
  if (name.includes(query)) return 500;
  // Subsequence: query chars appear in order within the name.
  let qi = 0;
  for (let ni = 0; ni < name.length && qi < query.length; ni++) {
    if (name[ni] === query[qi]) qi++;
  }
  return qi === query.length ? 200 : -1;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function RichInput({
  value,
  onChange,
  onSend,
  disabled = false,
  placeholder = 'How can I help you code today?',
  onAddSkill,
  mcpServers,
  onConnectMcp,
  profiles,
  activeProfileId,
  onSelectProfile,
  busy = false,
  onStop,
  commands = [],
  onUnknownCommand,
  contextInfo = null,
  capabilities = { tools: true, vision: true },
}: RichInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [showSkillsPanel, setShowSkillsPanel] = useState(false);
  const [showMcpPanel, setShowMcpPanel] = useState(false);

  /* Auto-resize textarea */
  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = '0';
    const next = Math.min(el.scrollHeight, 200); // max ~8 lines
    el.style.height = `${next}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [value, resize]);

  /* Slash command menu */
  const [cmdIndex, setCmdIndex] = useState(0);
  // Only active while still typing the command token — null once a space is
  // present, so the menu closes during the argument phase.
  const cmdQuery =
    value.startsWith('/') && !value.slice(1).includes(' ') ? value.slice(1).toLowerCase() : null;
  const cmdMatches =
    cmdQuery === null
      ? []
      : commands
        .map((c) => ({ cmd: c, score: scoreCommand(cmdQuery, c.name.toLowerCase()) }))
        .filter((m) => m.score >= 0)
        .sort(
          (a, b) =>
            b.score - a.score ||
            a.cmd.name.length - b.cmd.name.length ||
            a.cmd.name.localeCompare(b.cmd.name),
        )
        .map((m) => m.cmd);
  useEffect(() => { setCmdIndex(0); }, [cmdQuery]);

  const runCommand = (cmd) => {
    const sp = value.indexOf(' ');
    const arg = sp >= 0 ? value.slice(sp + 1).trim() || undefined : undefined;
    onChange('');
    cmd.run(arg);
  };

  /* Complete the command into the input (does not run it) so the user can
     add an argument. Trailing space closes the menu via cmdQuery. */
  const completeCommand = (cmd) => {
    onChange(`/${cmd.name} `);
    textareaRef.current?.focus();
  };

  const tryRunUnknownCommand = () => {
    if (!value.startsWith('/')) return false;
    const sp = value.indexOf(' ');
    const name = sp >= 0 ? value.slice(1, sp).trim() : value.slice(1).trim();
    const arg = sp >= 0 ? value.slice(sp + 1).trim() || undefined : undefined;
    const match = commands.find((c) => c.name === name);
    if (match) {
      runCommand(match);
      return true;
    }
    if (onUnknownCommand && name) {
      onChange('');
      onUnknownCommand(name, arg);
      return true;
    }
    return false;
  };

  /* Keyboard */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (cmdMatches.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCmdIndex((i) => (i + 1) % cmdMatches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCmdIndex((i) => (i - 1 + cmdMatches.length) % cmdMatches.length); return; }
      if (e.key === 'Escape') { e.preventDefault(); onChange(''); return; }
      if (e.key === 'Tab') { e.preventDefault(); completeCommand(cmdMatches[Math.min(cmdIndex, cmdMatches.length - 1)]); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runCommand(cmdMatches[Math.min(cmdIndex, cmdMatches.length - 1)]); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (value.startsWith('/') && tryRunUnknownCommand()) return;
      onSend();
    }
  };

  const connectedCount = mcpServers.filter((s) => s.status === 'connected').length;

  return (
    <div
      className={`rich-input-container ${isFocused ? 'rich-input-focused' : ''} ${disabled ? 'rich-input-disabled' : ''}`}
    >
      {cmdMatches.length > 0 && (
        <div className="ri-cmd-menu">
          {cmdMatches.map((c, i) => (
            <div
              key={c.name}
              className={`ri-cmd-item ${i === cmdIndex ? 'ri-cmd-active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); completeCommand(c); }}
            >
              <span className="ri-cmd-name">/{c.name}</span>
              <span className="ri-cmd-desc">{c.description}</span>
            </div>
          ))}
        </div>
      )}

      {/* ---- Textarea ---- */}
      <textarea
        ref={textareaRef}
        className="rich-input-textarea"
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        disabled={disabled}
        placeholder={placeholder}
      />

      {/* ---- Bottom toolbar ---- */}
      <div className="rich-input-toolbar">
        <div className="ri-toolbar-left">
          {profiles.length > 0 && (
            <select
              className="ri-toolbar-btn"
              style={{ maxWidth: '160px', cursor: 'pointer' }}
              value={activeProfileId ?? ''}
              onChange={(e) => onSelectProfile(e.target.value)}
              disabled={disabled && profiles.length < 2}
              title="Switch model"
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          )}

          {/* Add skill */}
          <button
            className="ri-toolbar-btn"
            onClick={onAddSkill}
            disabled={disabled}
            title="Add skills"
          >
            <Puzzle size={16} />
            <span className="ri-toolbar-btn-label">
              Skills
            </span>
          </button>

          {/* Connect MCP */}
          <button
            className="ri-toolbar-btn"
            onClick={onConnectMcp}
            disabled={disabled || !capabilities.tools}
            title={capabilities.tools ? 'Connect MCP servers' : 'This model does not support tool calling'}
          >
            <Globe size={16} />
            <span className="ri-toolbar-btn-label">
              MCPs
              {connectedCount > 0 && (
                <span className="ri-badge">{connectedCount}</span>
              )}
            </span>
          </button>

          {/* Attach file (placeholder action) */}
          <button
            className="ri-toolbar-btn"
            disabled={disabled || !capabilities.vision}
            title={capabilities.vision ? 'Attach files' : 'This model does not support images'}
          >
            <Paperclip size={16} />
          </button>
        </div>

        {/* Context window indicator */}
        {contextInfo && (
          <span
            className={`ri-context-chip ${contextInfo.pct >= 0.9 ? 'ri-context-danger' : contextInfo.pct >= 0.7 ? 'ri-context-warn' : ''}`}
            title={`Context window: ${contextInfo.estimated ? 'estimated ' : ''}${(contextInfo.lastInputTokens + contextInfo.lastOutputTokens).toLocaleString()} of ${contextInfo.contextWindow.toLocaleString()} tokens used`}
          >
            {contextInfo.estimated ? '~' : ''}{Math.round(contextInfo.pct * 100)}% · {fmtTok(contextInfo.lastInputTokens + contextInfo.lastOutputTokens)}/{fmtTok(contextInfo.contextWindow)}
          </span>
        )}

        {/* Send / Stop */}
        {busy ? (
          <button
            className="ri-send-btn ri-send-active"
            onClick={onStop}
            aria-label="Stop generation"
            title="Stop"
          >
            <Square size={14} />
          </button>
        ) : (
          <button
            className={`ri-send-btn ${value.trim() && !disabled ? 'ri-send-active' : ''}`}
            onClick={onSend}
            disabled={!value.trim() || disabled}
            aria-label="Send message"
          >
            <Send size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
