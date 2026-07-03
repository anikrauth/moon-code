// @ts-nocheck
import React from 'react';
import { History, Trash2, MessageSquare } from 'lucide-react';

function relativeTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function SessionsPanel({ sessions, onSelect, onDelete, busy }) {
  return (
    <>
      <div className="sp-header">
        <div className="sp-header-title">
          <History size={18} />
          <h3>Sessions</h3>
        </div>
      </div>
      <div className="sp-catalog">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`sp-skill-row session-row ${busy ? 'session-row-busy' : ''}`}
            onClick={() => !busy && onSelect(s.id)}
          >
            <div className="sp-skill-info">
              <MessageSquare size={14} className="sp-skill-icon" />
              <div>
                <span className="sp-skill-name">{s.title || 'Untitled chat'}</span>
                <span className="sp-skill-desc">{s.workspace?.split('/').pop()} · {relativeTime(s.updatedAt)}</span>
              </div>
            </div>
            <button
              className="sp-close"
              aria-label={`Delete ${s.title || 'session'}`}
              onClick={(e) => { e.stopPropagation(); if (!busy) onDelete(s.id); }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {sessions.length === 0 && <div className="sp-empty">No saved sessions yet.</div>}
      </div>
    </>
  );
}
