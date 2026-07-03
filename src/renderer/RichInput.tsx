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

export interface SkillItem {
  id: string;
  name: string;
  description?: string;
}

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
  /** Active skills attached to this prompt */
  skills: SkillItem[];
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
  skills,
  onAddSkill,
  mcpServers,
  onConnectMcp,
  profiles,
  activeProfileId,
  onSelectProfile,
  busy = false,
  onStop,
  commands = [],
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
  const cmdQuery = value.startsWith('/') ? value.slice(1).split(' ')[0].toLowerCase() : null;
  const cmdMatches = cmdQuery !== null ? commands.filter((c) => c.name.startsWith(cmdQuery)) : [];
  useEffect(() => { setCmdIndex(0); }, [cmdQuery]);

  const runCommand = (cmd) => {
    const sp = value.indexOf(' ');
    const arg = sp >= 0 ? value.slice(sp + 1).trim() || undefined : undefined;
    onChange('');
    cmd.run(arg);
  };

  /* Keyboard */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (cmdMatches.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCmdIndex((i) => (i + 1) % cmdMatches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCmdIndex((i) => (i - 1 + cmdMatches.length) % cmdMatches.length); return; }
      if (e.key === 'Escape') { e.preventDefault(); onChange(''); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runCommand(cmdMatches[Math.min(cmdIndex, cmdMatches.length - 1)]); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
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
              onMouseDown={(e) => { e.preventDefault(); runCommand(c); }}
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
              {skills.length > 0 && (
                <span className="ri-badge">{skills.length}</span>
              )}
            </span>
          </button>

          {/* Connect MCP */}
          <button
            className="ri-toolbar-btn"
            onClick={onConnectMcp}
            disabled={disabled}
            title="Connect MCP servers"
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
            disabled={disabled}
            title="Attach files"
          >
            <Paperclip size={16} />
          </button>
        </div>

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
