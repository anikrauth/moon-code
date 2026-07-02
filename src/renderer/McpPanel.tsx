// @ts-nocheck
import React from 'react';
import { X, Globe, Plug, Plus, Loader2, CheckCircle2, XCircle, Pencil, Trash2 } from 'lucide-react';

export default function McpPanel({ open, onClose, servers, statuses, busy, onConnect, onDisconnect, onEdit, onDelete, onAdd }) {
  if (!open) return null;
  const statusIcon = (id) => {
    const st = statuses[id]?.status ?? 'disconnected';
    if (st === 'connected') return <CheckCircle2 size={14} className="mcp-status-connected" />;
    if (st === 'connecting') return <Loader2 size={14} className="mcp-status-connecting" />;
    if (st === 'error') return <XCircle size={14} className="mcp-status-error" title={statuses[id]?.message} />;
    return <XCircle size={14} className="mcp-status-disconnected" />;
  };
  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mcp-panel glass-panel">
        <div className="sp-header">
          <div className="sp-header-title"><Globe size={18} /><h3>MCP Servers</h3></div>
          <button className="sp-close" onClick={onClose} aria-label="Close MCP panel"><X size={16} /></button>
        </div>
        <div className="sp-catalog">
          {servers.map((server) => {
            const st = statuses[server.id]?.status ?? 'disconnected';
            const connected = st === 'connected';
            return (
              <div key={server.id} className="mcp-server-row">
                <div className="mcp-server-info">
                  <div className="mcp-server-icon-wrap"><Plug size={16} /></div>
                  <div className="mcp-server-text">
                    <div className="mcp-server-name-row">
                      <span className="mcp-server-name">{server.name}</span>
                      {statusIcon(server.id)}
                    </div>
                    <span className="sp-skill-desc">
                      {server.transport === 'http' ? server.url : `${server.command ?? ''} ${(server.args ?? []).join(' ')}`}
                    </span>
                    <div className="mcp-server-meta">
                      <span className="mcp-meta-tag">{server.transport}</span>
                      {connected && <span className="mcp-meta-tag">{statuses[server.id]?.toolCount ?? 0} tools</span>}
                      {st === 'error' && <span className="mcp-meta-tag mcp-meta-error">{statuses[server.id]?.message?.slice(0, 60)}</span>}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <button className="sp-close" aria-label={`Edit ${server.name}`} onClick={() => !busy && onEdit(server)}><Pencil size={14} /></button>
                  <button className="sp-close" aria-label={`Delete ${server.name}`} onClick={() => !busy && onDelete(server.id)}><Trash2 size={14} /></button>
                  <button
                    className={`mcp-toggle-btn ${connected ? 'mcp-toggle-disconnect' : ''}`}
                    onClick={() => !busy && (connected ? onDisconnect(server.id) : onConnect(server.id))}
                    disabled={st === 'connecting'}
                  >
                    {st === 'connecting' ? 'Connecting…' : connected ? 'Disconnect' : 'Connect'}
                  </button>
                </div>
              </div>
            );
          })}
          {servers.length === 0 && <div className="sp-empty">No MCP servers configured yet.</div>}
        </div>
        <button
          onClick={() => !busy && onAdd()}
          style={{ margin: '12px', background: 'var(--accent-color)', color: '#000', border: 'none', borderRadius: '8px', padding: '10px', cursor: 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
        >
          <Plus size={14} /> Add Server
        </button>
      </div>
    </div>
  );
}
