// @ts-nocheck
import React, { useState, useEffect, useRef } from 'react';
import { FolderOpen, Settings, Bot, X, Plus, History } from 'lucide-react';
import RichInput, { SkillItem, McpServer } from './RichInput';
import SkillsPanel, { SkillEntry, SKILL_CATALOG } from './SkillsPanel';
import McpPanel, { McpServerEntry, MCP_CATALOG } from './McpPanel';
import SessionsPanel from './SessionsPanel';
import { JSONUIProvider, Renderer } from '@json-render/react';
import { registry } from './uiRegistry';
import { parseAssistantContent } from './parseAssistantContent';

/* Renderer throws on specs that pass validation but fail at render time;
   without a boundary React unmounts the whole app. Fall back to raw text. */
class SpecErrorBoundary extends React.Component<{ fallback: React.ReactNode; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/* While a response streams in, the accumulated JSONL is usually not yet a valid
   spec — render the last spec that parsed instead of flashing raw JSON. */
function AssistantContent({ content, streaming }: { content: string; streaming: boolean }) {
  const lastGoodSpec = useRef<any>(null);
  const spec = parseAssistantContent(content);
  if (spec) lastGoodSpec.current = spec;
  const displaySpec = spec ?? (streaming ? lastGoodSpec.current : null);

  if (displaySpec) {
    return (
      <SpecErrorBoundary fallback={content}>
        <JSONUIProvider
          key={JSON.stringify(displaySpec.state ?? null)}
          registry={registry}
          initialState={displaySpec.state ?? {}}
        >
          <Renderer spec={displaySpec} registry={registry} />
        </JSONUIProvider>
      </SpecErrorBoundary>
    );
  }
  if (streaming) return <span>&hellip;</span>;
  return <>{content}</>;
}

function ToolActivity({ tool }: { tool: any }) {
  const [expanded, setExpanded] = useState(false);
  let preview = '';
  try {
    const args = JSON.parse(tool.arguments ?? '{}');
    preview = args.command ?? args.filePath ?? args.dirPath ?? args.task ?? '';
  } catch {
    // unparseable arguments — show no preview
  }
  if (preview.length > 60) preview = `${preview.slice(0, 60)}…`;
  const result = tool.result;
  const hasResult = tool.result != null;
  const isError = hasResult && (result.startsWith('Error:') || result === 'User denied permission for this action.' || result === 'aborted');
  const summary = hasResult ? ((result.split('\n').find((l: string) => l.trim()) ?? '').slice(0, 80) || '(no output)') : null;
  return (
    <div className="activity-item">
      <div
        className={`activity-line ${hasResult ? 'activity-clickable' : ''}`}
        onClick={() => hasResult && setExpanded((e) => !e)}
        title={hasResult ? (expanded ? 'Collapse output' : 'Expand output') : undefined}
      >
        <span className={`activity-marker ${hasResult ? '' : 'activity-pending'}`}>⏺</span>
        {tool.agent && tool.agent !== 'main' && <span className="agent-badge">{tool.agent}</span>}
        <span className="activity-label"><strong>{tool.name}</strong>{preview ? `(${preview})` : ''}</span>
      </div>
      {summary != null && !expanded && (
        <div className={`activity-result-summary ${isError ? 'activity-error' : ''}`}>⎿ {summary}</div>
      )}
      {expanded && hasResult && <pre className="activity-result-full">{result}</pre>}
    </div>
  );
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: any[];
}

/* StrictMode double-invokes effects in dev; both invocations would await
   getConfig() concurrently, both see profiles.length === 0, and both run the
   one-time migration — duplicating the "Default" profile. Module-level (not a
   ref) so the guard also survives a StrictMode unmount/remount cycle. */
let configLoadStarted = false;

export default function App() {
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [history, setHistory] = useState<any[] | undefined>(undefined);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [config, setConfig] = useState<any>(null);
  const [profileForm, setProfileForm] = useState<any>(null); // null = closed; {} = new; {id,...} = edit

  /* ---- Skills state ---- */
  const [activeSkills, setActiveSkills] = useState<SkillItem[]>([]);
  const [showSkillsPanel, setShowSkillsPanel] = useState(false);

  /* ---- MCP state ---- */
  const [permissionQueue, setPermissionQueue] = useState<any[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [mcpStatuses, setMcpStatuses] = useState<Record<string, 'connected' | 'disconnected' | 'connecting'>>({});
  const [showMcpPanel, setShowMcpPanel] = useState(false);

  /* ---- Sessions state ---- */
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [sessionList, setSessionList] = useState<any[]>([]);
  const [showSessionsPanel, setShowSessionsPanel] = useState(false);

  const applyConfig = (c: any) => {
    setConfig(c);
    setActiveSkills(
        c.activeSkillIds
            .map((id: string) => SKILL_CATALOG.find((s) => s.id === id))
            .filter(Boolean)
            .map((s: any) => ({ id: s.id, name: s.name, description: s.description }))
    );
    const servers = c.connectedMcpIds
        .map((id: string) => MCP_CATALOG.find((m) => m.id === id))
        .filter(Boolean)
        .map((m: any) => ({ id: m.id, name: m.name, status: 'connected', tools: m.tools }));
    setMcpServers(servers);
    setMcpStatuses(Object.fromEntries(servers.map((s: any) => [s.id, 'connected'])));
  };

  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  /* The `done` handler runs inside a listener registered once (see the `[]`
     effect below), so it cannot read fresh React state — it would see stale
     closures. This ref is kept in sync via its own effect and read from
     inside the done branch instead. */
  const sessionSnapshotRef = useRef<any>({ messages: [], workspace: null, sessionId: null });
  useEffect(() => {
    sessionSnapshotRef.current = { messages, workspace, sessionId: currentSessionId };
  }, [messages, workspace, currentSessionId]);

  useEffect(() => {
    // Listen for events from main process (only available inside Electron)
    if (!window.electron?.onAgentEvent) return;
    window.electron.onAgentEvent((event: any) => {
      if (event.type === 'done') {
        setIsTyping(false);
        setStatusText(null);
        setPermissionQueue([]);
        if (event.history) {
          setHistory(event.history);
          const snap = sessionSnapshotRef.current;
          const firstUser = snap.messages.find((m: any) => m.role === 'user');
          if (firstUser && snap.workspace) {
            window.electron?.saveSession({
              id: snap.sessionId ?? undefined,
              title: firstUser.content.trim().slice(0, 60),
              workspace: snap.workspace,
              messages: snap.messages,
              history: event.history,
            }).then((id: string) => { if (id) setCurrentSessionId(id); });
          }
        }
        return;
      }
      if (event.type === 'permission_request') {
        setPermissionQueue(prev => [...prev, event]);
        return;
      }
      if (event.type === 'status') {
        setStatusText(event.content);
        return;
      }
      setMessages(prev => {
        const newMsgs = [...prev];
        const lastIdx = newMsgs.length - 1;
        const lastMsg = newMsgs[lastIdx];

        if (event.type === 'message') {
            if (lastMsg && lastMsg.role === 'assistant') {
                newMsgs[lastIdx] = { ...lastMsg, content: lastMsg.content + event.content };
            } else {
                newMsgs.push({ id: Date.now().toString(), role: 'assistant', content: event.content });
            }
        } else if (event.type === 'tool_call') {
            if (lastMsg && lastMsg.role === 'assistant') {
                newMsgs[lastIdx] = { ...lastMsg, toolCalls: [...(lastMsg.toolCalls || []), event] };
            } else {
                newMsgs.push({ id: Date.now().toString(), role: 'assistant', content: '', toolCalls: [event] });
            }
        } else if (event.type === 'tool_result') {
            if (lastMsg && lastMsg.toolCalls) {
                const callIdx = lastMsg.toolCalls.findIndex((c: any) =>
                    c.name === event.name && (c.agent ?? 'main') === (event.agent ?? 'main') && !c.result);
                if (callIdx !== -1) {
                    const toolCalls = [...lastMsg.toolCalls];
                    toolCalls[callIdx] = { ...toolCalls[callIdx], result: event.result };
                    newMsgs[lastIdx] = { ...lastMsg, toolCalls };
                }
            }
        } else if (event.type === 'error') {
            if (lastMsg && lastMsg.role === 'assistant' && lastMsg.toolCalls) {
                newMsgs[lastIdx] = {
                    ...lastMsg,
                    toolCalls: lastMsg.toolCalls.map((c: any) => c.result ? c : { ...c, result: 'aborted' }),
                };
            }
            newMsgs.push({ id: Date.now().toString(), role: 'assistant', content: `Error: ${event.content}` });
        }
        return newMsgs;
      });
    });
  }, []);

  useEffect(() => {
    if (configLoadStarted) return;
    configLoadStarted = true;
    (async () => {
        if (!window.electron?.getConfig) return;
        let c = await window.electron.getConfig();
        if (c.profiles.length === 0) {
            const saved = localStorage.getItem('moon-agent-settings');
            if (saved) {
                let old: any = null;
                try {
                    old = JSON.parse(saved);
                } catch {
                    // unparseable legacy settings — drop them
                    localStorage.removeItem('moon-agent-settings');
                }
                if (old && old.apiKey) {
                    try {
                        c = await window.electron.upsertProfile(
                            { name: 'Default', provider: old.provider || 'OpenAI', model: old.model || 'gpt-4o', baseUrl: old.baseUrl || '' },
                            old.apiKey
                        );
                        // Only drop the legacy copy once the migrated profile is durably
                        // confirmed to have a key on the main-side config; otherwise a
                        // silent persist failure would discard the user's only API key.
                        if (c.profiles.some((p: any) => p.hasKey)) localStorage.removeItem('moon-agent-settings');
                    } catch {
                        // IPC call rejected — keep the legacy entry so the next launch retries
                    }
                }
            }
        }
        applyConfig(c);
    })();
  }, []);

  const startNewChat = () => {
    setMessages([]);
    setHistory(undefined);
    setCurrentSessionId(null);
  };

  const selectWorkspace = async () => {
    if (!window.electron?.selectFolder) return;
    const path = await window.electron.selectFolder();
    if (path) {
      setWorkspace(path);
      startNewChat();
    }
  };

  const activeProfile = config?.profiles.find((p: any) => p.id === config.activeProfileId) ?? null;

  const handleSend = () => {
    if (!input.trim() || !workspace || !activeProfile?.hasKey) return;

    const newMsg: ChatMessage = { id: Date.now().toString(), role: 'user', content: input };
    setMessages(prev => [...prev, newMsg]);
    setInput('');
    setIsTyping(true);
    setStatusText(null);

    window.electron?.sendPrompt(input, workspace, config.activeProfileId, history);
  };

  /* ---- Skills handlers ---- */
  const handleToggleSkill = (skill: SkillEntry) => {
    setActiveSkills((prev) => {
      const exists = prev.find((s) => s.id === skill.id);
      const next = exists
        ? prev.filter((s) => s.id !== skill.id)
        : [...prev, { id: skill.id, name: skill.name, description: skill.description }];
      window.electron?.setSkillIds(next.map((s) => s.id));
      return next;
    });
  };

  const handleRemoveSkill = (id: string) => {
    setActiveSkills((prev) => {
      const next = prev.filter((s) => s.id !== id);
      window.electron?.setSkillIds(next.map((s) => s.id));
      return next;
    });
  };

  /* ---- Sessions handlers ---- */
  const handleSelectSession = async (id: string) => {
    const s = await window.electron?.getSession(id);
    if (!s) return;
    setWorkspace(s.workspace);
    setMessages(s.messages ?? []);
    setHistory(s.history ?? undefined);
    setCurrentSessionId(s.id);
    setShowSessionsPanel(false);
  };

  const handleDeleteSession = async (id: string) => {
    const list = await window.electron?.deleteSession(id);
    setSessionList(list ?? []);
    if (id === currentSessionId) setCurrentSessionId(null);
  };

  /* ---- MCP handlers ---- */
  const handleToggleMcp = (server: McpServerEntry) => {
    if (mcpStatuses[server.id] === 'connecting') return;
    const isConnected = mcpServers.some((s) => s.id === server.id);
    if (isConnected) {
      setMcpServers((prev) => {
        const next = prev.filter((s) => s.id !== server.id);
        window.electron?.setMcpIds(next.map((s) => s.id));
        return next;
      });
      setMcpStatuses((prev) => {
        const next = { ...prev };
        delete next[server.id];
        return next;
      });
    } else {
      // Simulate connection
      setMcpStatuses((prev) => ({ ...prev, [server.id]: 'connecting' }));
      setTimeout(() => {
        setMcpServers((prev) => {
          if (prev.some((s) => s.id === server.id)) return prev;
          const next = [...prev, { id: server.id, name: server.name, status: 'connected', tools: server.tools }];
          window.electron?.setMcpIds(next.map((s) => s.id));
          return next;
        });
        setMcpStatuses((prev) => {
          if (prev[server.id] !== 'connecting') return prev;
          return { ...prev, [server.id]: 'connected' };
        });
      }, 800);
    }
  };

  const handleDisconnectMcp = (id: string) => {
    setMcpServers((prev) => {
      const next = prev.filter((s) => s.id !== id);
      window.electron?.setMcpIds(next.map((s) => s.id));
      return next;
    });
    setMcpStatuses((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const respondPermission = (allow: boolean, alwaysAllow: boolean) => {
    const req = permissionQueue[0];
    if (!req) return;
    window.electron?.respondPermission(req.id, allow, alwaysAllow);
    setPermissionQueue(prev => prev.slice(1));
  };

  const permissionDetail = (req: any) => {
    if (req.name === 'run_command') return req.arguments?.command;
    if (req.name === 'edit_file') return `${req.arguments?.filePath}\n--- remove\n${req.arguments?.oldString}\n+++ add\n${req.arguments?.newString}`;
    return req.arguments?.filePath ?? JSON.stringify(req.arguments);
  };

  const providerOptions = [
    { label: 'OpenAI', defaultBase: '', defaultModel: 'gpt-4o' },
    { label: 'Zhipu AI (GLM)', defaultBase: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4' },
    { label: 'OpenRouter', defaultBase: 'https://openrouter.ai/api/v1', defaultModel: 'anthropic/claude-3-opus' },
    { label: 'Cloudflare Workers AI', defaultBase: 'https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1', defaultModel: '@cf/meta/llama-3-8b-instruct' },
    { label: 'Anthropic', defaultBase: 'https://api.anthropic.com/v1', defaultModel: 'claude-3-opus-20240229' },
    { label: 'Custom (OpenAI-Compatible)', defaultBase: '', defaultModel: '' }
  ];

  const inputDisabled = !workspace || isTyping || !activeProfile?.hasKey;
  const inputPlaceholder = !workspace
    ? 'Select a workspace to get started...'
    : !activeProfile?.hasKey
      ? 'Add a model profile in Settings…'
      : 'Ask Moon Agent anything. Shift+Enter for new line.';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '20px', paddingTop: '40px', position: 'relative', boxSizing: 'border-box' }}>
      
      {/* Settings Modal */}
      {showSettings && (
        <div className="modal-overlay">
          <div className="glass-panel modal-content">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}>Settings</h3>
                <X size={18} style={{ cursor: 'pointer' }} onClick={() => setShowSettings(false)} />
            </div>
            
            {!profileForm ? (
                <>
                    {config?.profiles.length === 0 && (
                        <p style={{ color: 'var(--text-secondary)' }}>No model profiles yet. Add one to start chatting.</p>
                    )}
                    {config?.profiles.map((p: any) => (
                        <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0', borderBottom: '1px solid var(--border-color)' }}>
                            <input type="radio" name="active-profile" checked={p.id === config.activeProfileId}
                                onChange={() => window.electron?.setActiveProfile(p.id).then(setConfig)} />
                            <div style={{ flexGrow: 1 }}>
                                <div style={{ fontWeight: 600 }}>{p.name}{!p.hasKey && <span style={{ color: 'salmon', fontSize: '11px', marginLeft: '6px' }}>no key</span>}</div>
                                <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{p.provider} · {p.model}</div>
                            </div>
                            <button className="glass-panel" style={{ padding: '4px 10px', cursor: 'pointer', color: 'var(--text-primary)' }}
                                onClick={() => setProfileForm({ id: p.id, name: p.name, provider: p.provider, model: p.model, baseUrl: p.baseUrl, apiKey: '', hasKey: p.hasKey })}>
                                Edit
                            </button>
                            <button className="glass-panel" style={{ padding: '4px 10px', cursor: 'pointer', color: 'salmon' }}
                                onClick={() => window.electron?.deleteProfile(p.id).then(setConfig)}>
                                Delete
                            </button>
                        </div>
                    ))}
                    <button onClick={() => setProfileForm({ name: '', provider: 'OpenAI', model: 'gpt-4o', baseUrl: '', apiKey: '' })}
                        style={{ background: 'var(--accent-color)', color: '#000', border: 'none', borderRadius: '8px', padding: '10px', cursor: 'pointer', fontWeight: 600, marginTop: '10px' }}>
                        Add Profile
                    </button>
                </>
            ) : (
                <>
                    <div>
                        <label>Profile Name</label>
                        <input type="text" value={profileForm.name} onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })} placeholder="e.g. GPT-4o (work)" />
                    </div>
                    <div>
                        <label>Provider</label>
                        <select value={profileForm.provider}
                            onChange={(e) => {
                                const opt = providerOptions.find((p) => p.label === e.target.value);
                                setProfileForm(profileForm.id
                                    ? { ...profileForm, provider: e.target.value } // editing: never clobber saved fields
                                    : { ...profileForm, provider: e.target.value, baseUrl: opt?.defaultBase || '', model: opt?.defaultModel || '' });
                            }}>
                            {providerOptions.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
                        </select>
                    </div>
                    <div>
                        <label>Model Name</label>
                        <input type="text" value={profileForm.model} onChange={(e) => setProfileForm({ ...profileForm, model: e.target.value })} placeholder="e.g. gpt-4o" />
                    </div>
                    <div>
                        <label>Base URL (Optional)</label>
                        <input type="text" value={profileForm.baseUrl} onChange={(e) => setProfileForm({ ...profileForm, baseUrl: e.target.value })} placeholder="Override endpoint URL..." />
                    </div>
                    <div>
                        <label>API Key</label>
                        <input type="password" value={profileForm.apiKey} onChange={(e) => setProfileForm({ ...profileForm, apiKey: e.target.value })}
                            placeholder={profileForm.hasKey ? '•••••••• (leave blank to keep)' : 'Enter your API Key...'} />
                    </div>
                    <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
                        <button className="glass-panel" style={{ padding: '10px', cursor: 'pointer', color: 'var(--text-primary)', flexGrow: 1 }} onClick={() => setProfileForm(null)}>Cancel</button>
                        <button
                            style={{ background: 'var(--accent-color)', color: '#000', border: 'none', borderRadius: '8px', padding: '10px', cursor: 'pointer', fontWeight: 600, flexGrow: 1 }}
                            disabled={!profileForm.name.trim() || !profileForm.model.trim()}
                            onClick={() => {
                                const { apiKey, hasKey, ...profile } = profileForm;
                                window.electron?.upsertProfile(profile, apiKey || undefined).then((c) => { setConfig(c); setProfileForm(null); });
                            }}>
                            Save Profile
                        </button>
                    </div>
                </>
            )}
          </div>
        </div>
      )}

      {/* Permission Request Modal */}
      {permissionQueue.length > 0 && (
        <div className="modal-overlay">
          <div className="glass-panel modal-content">
            <h3 style={{ margin: 0 }}>Permission required</h3>
            <p style={{ margin: '8px 0', color: 'var(--text-secondary)' }}>
                {permissionQueue[0].agent && permissionQueue[0].agent !== 'main' ? `Subagent ${permissionQueue[0].agent}` : 'The agent'} wants to run <strong>{permissionQueue[0].name}</strong>:
            </p>
            <pre style={{
              background: 'rgba(0,0,0,0.4)',
              padding: '10px',
              borderRadius: '8px',
              maxHeight: '200px',
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              fontSize: '12px',
              margin: 0
            }}>{permissionDetail(permissionQueue[0])}</pre>
            <div style={{ display: 'flex', gap: '10px', marginTop: '14px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => respondPermission(false, false)}
                className="glass-panel"
                style={{ padding: '8px 14px', cursor: 'pointer', color: 'var(--text-primary)' }}
              >
                Deny
              </button>
              <button
                onClick={() => respondPermission(true, false)}
                className="glass-panel"
                style={{ padding: '8px 14px', cursor: 'pointer', color: 'var(--text-primary)' }}
              >
                Allow once
              </button>
              <button
                onClick={() => respondPermission(true, true)}
                style={{
                  padding: '8px 14px',
                  cursor: 'pointer',
                  background: 'var(--accent-color)',
                  color: '#000',
                  border: 'none',
                  borderRadius: '8px',
                  fontWeight: 600
                }}
              >
                Always allow ({permissionQueue[0].name})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Skills Panel */}
      <SkillsPanel
        open={showSkillsPanel}
        onClose={() => setShowSkillsPanel(false)}
        activeSkillIds={activeSkills.map((s) => s.id)}
        onToggleSkill={handleToggleSkill}
      />

      {/* MCP Panel */}
      <McpPanel
        open={showMcpPanel}
        onClose={() => setShowMcpPanel(false)}
        connectedIds={mcpServers.map((s) => s.id)}
        serverStatuses={mcpStatuses}
        onToggleServer={handleToggleMcp}
      />

      {/* Sessions Panel */}
      <SessionsPanel
        open={showSessionsPanel}
        onClose={() => setShowSessionsPanel(false)}
        sessions={sessionList}
        onSelect={handleSelectSession}
        onDelete={handleDeleteSession}
        busy={isTyping}
      />

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ background: 'var(--accent-color)', borderRadius: '50%', padding: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Bot size={20} color="#fff" />
            </div>
            <h1 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>Moon Agent</h1>
        </div>
        
        <div style={{ display: 'flex', gap: '10px' }}>
            <button 
            onClick={selectWorkspace}
            className="glass-panel"
            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '14px' }}
            >
            <FolderOpen size={16} />
            {workspace ? workspace.split('/').pop() : 'Select Workspace'}
            </button>

            <button
              onClick={async () => {
                const list = await window.electron?.listSessions();
                setSessionList(list ?? []);
                setShowSessionsPanel(true);
              }}
              className="glass-panel"
              style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', color: 'var(--text-primary)', cursor: 'pointer' }}
              title="Sessions"
            >
              <History size={16} />
            </button>

            <button
            onClick={startNewChat}
            className="glass-panel"
            style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', color: 'var(--text-primary)', cursor: 'pointer' }}
            title="New Chat"
            >
            <Plus size={16} />
            </button>

            <button
            onClick={() => setShowSettings(true)}
            className="glass-panel"
            style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', color: 'var(--text-primary)', cursor: 'pointer' }}
            >
            <Settings size={16} />
            </button>
        </div>
      </div>

      {/* Chat Area */}
      <div className="chat-container glass-panel" style={{ flexGrow: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
        {messages.length === 0 ? (
            <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-secondary)' }}>
                <h2>How can I help you code today?</h2>
                <p>Select a workspace and start chatting.</p>
            </div>
        ) : (
            messages.map((msg, i) => {
                return (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
                    {msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0 && (
                        <div className="activity-block">
                            {msg.toolCalls.map((tool: any, j: number) => <ToolActivity key={j} tool={tool} />)}
                        </div>
                    )}
                    {(msg.role === 'user' || msg.content !== '' || (isTyping && i === messages.length - 1)) && (
                        <div style={{
                            background: msg.role === 'user' ? 'var(--accent-color)' : 'rgba(255,255,255,0.05)',
                            color: msg.role === 'user' ? '#000' : 'var(--text-primary)',
                            padding: '12px 16px',
                            borderRadius: '12px',
                            maxWidth: '80%',
                            lineHeight: '1.5'
                        }}>
                            {msg.role === 'assistant' ? (
                                <AssistantContent content={msg.content} streaming={isTyping && i === messages.length - 1} />
                            ) : msg.content}
                        </div>
                    )}
                </div>
                );
            })
        )}
        {isTyping && (
            <div style={{ color: 'var(--text-secondary)', fontSize: '14px', padding: '10px' }}>
                {statusText ?? 'Agent is thinking...'}
            </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Rich Input */}
      <div style={{ marginTop: '20px' }}>
        <RichInput
          value={input}
          onChange={setInput}
          onSend={handleSend}
          disabled={inputDisabled}
          placeholder={inputPlaceholder}
          skills={activeSkills}
          onAddSkill={() => setShowSkillsPanel(true)}
          onRemoveSkill={handleRemoveSkill}
          mcpServers={mcpServers}
          onConnectMcp={() => setShowMcpPanel(true)}
          onDisconnectMcp={handleDisconnectMcp}
          profiles={config?.profiles ?? []}
          activeProfileId={config?.activeProfileId ?? null}
          onSelectProfile={(id) => window.electron?.setActiveProfile(id).then(setConfig)}
          busy={isTyping}
          onStop={() => window.electron?.cancelPrompt()}
        />
      </div>
    </div>
  );
}
