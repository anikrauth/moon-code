// @ts-nocheck
import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Send,
  Square,
  Plus,
  Puzzle,
  Plug,
  Paperclip,
  X,
  ChevronDown,
  Globe,
  Wrench,
  Zap,
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
  onRemoveSkill: (id: string) => void;
  /** Connected MCP servers */
  mcpServers: McpServer[];
  onConnectMcp: () => void;
  onDisconnectMcp: (id: string) => void;
  /** Model profiles */
  profiles: { id: string; name: string }[];
  activeProfileId: string | null;
  onSelectProfile: (id: string) => void;
  busy?: boolean;
  onStop?: () => void;
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
  onRemoveSkill,
  mcpServers,
  onConnectMcp,
  onDisconnectMcp,
  profiles,
  activeProfileId,
  onSelectProfile,
  busy = false,
  onStop,
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

  /* Keyboard */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  const connectedCount = mcpServers.filter((s) => s.status === 'connected').length;
  const hasAttachments = skills.length > 0 || connectedCount > 0;

  return (
    <div
      className={`rich-input-container ${isFocused ? 'rich-input-focused' : ''} ${disabled ? 'rich-input-disabled' : ''}`}
    >
      {/* ---- Attached chips (skills + MCPs) ---- */}
      {hasAttachments && (
        <div className="rich-input-chips">
          {skills.map((skill) => (
            <span key={skill.id} className="ri-chip ri-chip-skill">
              <Zap size={12} />
              <span className="ri-chip-label">{skill.name}</span>
              <button
                className="ri-chip-remove"
                onClick={() => onRemoveSkill(skill.id)}
                aria-label={`Remove ${skill.name}`}
              >
                <X size={10} />
              </button>
            </span>
          ))}

          {mcpServers
            .filter((s) => s.status === 'connected')
            .map((srv) => (
              <span key={srv.id} className="ri-chip ri-chip-mcp">
                <Plug size={12} />
                <span className="ri-chip-label">{srv.name}</span>
                {srv.tools != null && (
                  <span className="ri-chip-meta">{srv.tools} tools</span>
                )}
                <button
                  className="ri-chip-remove"
                  onClick={() => onDisconnectMcp(srv.id)}
                  aria-label={`Disconnect ${srv.name}`}
                >
                  <X size={10} />
                </button>
              </span>
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
            <span className="ri-toolbar-btn-label">Skills</span>
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
