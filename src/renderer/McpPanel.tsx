// @ts-nocheck
import React, { useState } from 'react';
import { X, Search, Globe, Plug, PlugZap, Plus, Loader2, CheckCircle2, XCircle } from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  MCP server catalog (mock data for demo)                            */
/* ------------------------------------------------------------------ */

export interface McpServerEntry {
  id: string;
  name: string;
  description: string;
  protocol: string;
  tools: number;
}

export const MCP_CATALOG: McpServerEntry[] = [
  { id: 'filesystem', name: 'Filesystem', description: 'Read and write files on the local filesystem', protocol: 'stdio', tools: 8 },
  { id: 'github', name: 'GitHub', description: 'Manage repos, PRs, issues, and actions', protocol: 'sse', tools: 14 },
  { id: 'postgres', name: 'PostgreSQL', description: 'Query and manage PostgreSQL databases', protocol: 'stdio', tools: 6 },
  { id: 'browser', name: 'Browser', description: 'Automate browser interactions and scraping', protocol: 'sse', tools: 10 },
  { id: 'slack', name: 'Slack', description: 'Send messages and manage Slack channels', protocol: 'sse', tools: 7 },
  { id: 'docker', name: 'Docker', description: 'Manage containers, images, and compose stacks', protocol: 'stdio', tools: 9 },
  { id: 'memory', name: 'Memory', description: 'Persistent memory and knowledge graph', protocol: 'stdio', tools: 4 },
  { id: 'puppeteer', name: 'Puppeteer', description: 'Headless browser automation and testing', protocol: 'stdio', tools: 12 },
];

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface McpPanelProps {
  open: boolean;
  onClose: () => void;
  connectedIds: string[];
  serverStatuses: Record<string, 'connected' | 'disconnected' | 'connecting'>;
  onToggleServer: (server: McpServerEntry) => void;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function McpPanel({
  open,
  onClose,
  connectedIds,
  serverStatuses,
  onToggleServer,
}: McpPanelProps) {
  const [search, setSearch] = useState('');

  if (!open) return null;

  const filtered = MCP_CATALOG.filter(
    (s) =>
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.description.toLowerCase().includes(search.toLowerCase()),
  );

  const StatusIcon = ({ id }: { id: string }) => {
    const status = serverStatuses[id] || 'disconnected';
    if (status === 'connected') return <CheckCircle2 size={14} className="mcp-status-connected" />;
    if (status === 'connecting') return <Loader2 size={14} className="mcp-status-connecting" />;
    return <XCircle size={14} className="mcp-status-disconnected" />;
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mcp-panel glass-panel">
        {/* Header */}
        <div className="sp-header">
          <div className="sp-header-title">
            <Globe size={18} />
            <h3>MCP Servers</h3>
          </div>
          <button className="sp-close" onClick={onClose} aria-label="Close MCP panel">
            <X size={16} />
          </button>
        </div>

        {/* Search */}
        <div className="sp-search-wrap">
          <Search size={14} className="sp-search-icon" />
          <input
            type="text"
            className="sp-search"
            placeholder="Search MCP servers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
        </div>

        {/* Server list */}
        <div className="sp-catalog">
          {filtered.map((server) => {
            const isConnected = connectedIds.includes(server.id);
            const status = serverStatuses[server.id] || 'disconnected';
            return (
              <button
                key={server.id}
                className={`mcp-server-row ${isConnected ? 'mcp-server-active' : ''}`}
                onClick={() => onToggleServer(server)}
              >
                <div className="mcp-server-info">
                  <div className="mcp-server-icon-wrap">
                    <Plug size={16} />
                  </div>
                  <div className="mcp-server-text">
                    <div className="mcp-server-name-row">
                      <span className="mcp-server-name">{server.name}</span>
                      <StatusIcon id={server.id} />
                    </div>
                    <span className="sp-skill-desc">{server.description}</span>
                    <div className="mcp-server-meta">
                      <span className="mcp-meta-tag">{server.protocol}</span>
                      <span className="mcp-meta-tag">{server.tools} tools</span>
                    </div>
                  </div>
                </div>
                <span className={`mcp-toggle-btn ${isConnected ? 'mcp-toggle-disconnect' : ''}`}>
                  {status === 'connecting' ? 'Connecting...' : isConnected ? 'Disconnect' : 'Connect'}
                </span>
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div className="sp-empty">No servers match your search.</div>
          )}
        </div>
      </div>
    </div>
  );
}
