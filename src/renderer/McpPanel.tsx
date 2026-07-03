// @ts-nocheck
import React, { useState } from 'react';
import { Globe, Plug, Plus, Loader2, CheckCircle2, XCircle, Pencil, Trash2, X } from 'lucide-react';

const MCP_PRESETS = [
  { name: 'Filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '{workspace}'], hint: null },
  { name: 'GitHub', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], hint: 'needs GITHUB_PERSONAL_ACCESS_TOKEN' },
  { name: 'Memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], hint: null },
  { name: 'Fetch', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'], hint: null },
  { name: 'Puppeteer', command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'], hint: null },
  { name: 'Sequential Thinking', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], hint: null },
];

const emptyForm = () => ({ name: '', transport: 'stdio', command: '', argsText: '', url: '', secretsText: '', hasSecrets: false });

export default function McpPanel({ servers, statuses, busy, onConnect, onDisconnect, onSaveServer, onDelete, onAddPreset }) {
  const [form, setForm] = useState(null); // null closed; {} new; {id,...} edit

  const statusIcon = (id) => {
    const st = statuses[id]?.status ?? 'disconnected';
    if (st === 'connected') return <CheckCircle2 size={14} className="mcp-status-connected" />;
    if (st === 'connecting') return <Loader2 size={14} className="mcp-status-connecting" />;
    if (st === 'error') return <XCircle size={14} className="mcp-status-error" title={statuses[id]?.message} />;
    return <XCircle size={14} className="mcp-status-disconnected" />;
  };

  const submitForm = () => {
    const def = {
      id: form.id, name: form.name.trim(), transport: form.transport,
      command: form.transport === 'stdio' ? form.command.trim() : undefined,
      args: form.transport === 'stdio' ? form.argsText.trim().split(/\s+/).filter(Boolean) : undefined,
      url: form.transport === 'http' ? form.url.trim() : undefined,
    };
    let rawSecrets;
    const lines = form.secretsText.split('\n').map((l: string) => l.trim()).filter(Boolean);
    if (lines.length > 0) {
      if (form.transport === 'stdio') {
        const env = {};
        for (const l of lines) { const i = l.indexOf('='); if (i > 0) env[l.slice(0, i)] = l.slice(i + 1); }
        rawSecrets = { env };
      } else {
        const headers = {};
        for (const l of lines) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
        rawSecrets = { headers };
      }
    }
    onSaveServer(def, rawSecrets);
    setForm(null);
  };

  return (
    <>
      <div className="sp-header">
        <div className="sp-header-title"><Globe size={18} /><h3>MCP Servers</h3></div>
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
                <button className="sp-close" aria-label={`Edit ${server.name}`}
                  onClick={() => !busy && setForm({ id: server.id, name: server.name, transport: server.transport, command: server.command ?? '', argsText: (server.args ?? []).join(' '), url: server.url ?? '', secretsText: '', hasSecrets: server.hasSecrets })}>
                  <Pencil size={14} />
                </button>
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
        {(() => {
          const taken = new Set(servers.map((s) => s.name.toLowerCase()));
          const suggestions = MCP_PRESETS.filter((p) => !taken.has(p.name.toLowerCase()));
          if (suggestions.length === 0 || busy) return null;
          return (
            <>
              <span className="sp-category-label" style={{ marginTop: '10px' }}>Suggested</span>
              {suggestions.map((p) => (
                <div key={p.name} className="mcp-server-row">
                  <div className="mcp-server-info">
                    <div className="mcp-server-icon-wrap"><Plug size={16} /></div>
                    <div className="mcp-server-text">
                      <span className="mcp-server-name">{p.name}</span>
                      <span className="sp-skill-desc">{p.command} {p.args.join(' ')}</span>
                      {p.hint && <span className="mcp-preset-hint">{p.hint}</span>}
                    </div>
                  </div>
                  <button className="mcp-toggle-btn" onClick={() => onAddPreset(p)}>Add</button>
                </div>
              ))}
            </>
          );
        })()}
      </div>

      {form && (
        <div className="sp-form" style={{ borderTop: '1px solid var(--border-color)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ fontSize: '13px' }}>{form.id ? 'Edit Server' : 'Add Server'}</strong>
            <button className="sp-close" onClick={() => setForm(null)}><X size={14} /></button>
          </div>
          <div>
            <label>Name</label>
            <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. GitHub" />
          </div>
          <div>
            <label>Transport</label>
            <select value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value })}>
              <option value="stdio">stdio (local command)</option>
              <option value="http">http (remote URL)</option>
            </select>
          </div>
          {form.transport === 'stdio' ? (
            <>
              <div>
                <label>Command</label>
                <input type="text" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="npx" />
              </div>
              <div>
                <label>Arguments (space-separated)</label>
                <input type="text" value={form.argsText} onChange={(e) => setForm({ ...form, argsText: e.target.value })} placeholder="-y @modelcontextprotocol/server-github" />
              </div>
            </>
          ) : (
            <div>
              <label>URL</label>
              <input type="text" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://example.com/mcp" />
            </div>
          )}
          <div>
            <label>{form.transport === 'stdio' ? 'Environment (KEY=value per line)' : 'Headers (Name: value per line)'}</label>
            <textarea
              rows={3}
              value={form.secretsText}
              onChange={(e) => setForm({ ...form, secretsText: e.target.value })}
              placeholder={form.hasSecrets ? '•••••••• (leave blank to keep)' : form.transport === 'stdio' ? 'GITHUB_TOKEN=ghp_…' : 'Authorization: Bearer …'}
            />
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="glass-panel" style={{ padding: '8px', cursor: 'pointer', color: 'var(--text-primary)', flexGrow: 1 }} onClick={() => setForm(null)}>Cancel</button>
            <button
              style={{ background: 'var(--accent-color)', color: '#000', border: 'none', borderRadius: 'var(--radius-md)', padding: '8px', cursor: 'pointer', fontWeight: 600, flexGrow: 1 }}
              disabled={!form.name.trim() || (form.transport === 'stdio' ? !form.command.trim() : !form.url.trim())}
              onClick={submitForm}
            >
              Save
            </button>
          </div>
        </div>
      )}

      <button
        onClick={() => !busy && setForm(emptyForm())}
        style={{ margin: '12px', background: 'var(--accent-color)', color: '#000', border: 'none', borderRadius: 'var(--radius-md)', padding: '10px', cursor: 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
      >
        <Plus size={14} /> Add Server
      </button>
    </>
  );
}
