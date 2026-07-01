// @ts-nocheck
import React, { useState, useEffect, useRef } from 'react';
import { FolderOpen, Terminal, FileEdit, Settings, Bot, X } from 'lucide-react';
import RichInput, { SkillItem, McpServer } from './RichInput';
import SkillsPanel, { SkillEntry } from './SkillsPanel';
import McpPanel, { McpServerEntry } from './McpPanel';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: any[];
}

interface AppSettings {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl: string;
}

export default function App() {
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(() => {
    const saved = localStorage.getItem('moon-agent-settings');
    return saved ? JSON.parse(saved) : { provider: 'OpenAI', apiKey: '', model: 'gpt-4o', baseUrl: '' };
  });

  /* ---- Skills state ---- */
  const [activeSkills, setActiveSkills] = useState<SkillItem[]>([]);
  const [showSkillsPanel, setShowSkillsPanel] = useState(false);

  /* ---- MCP state ---- */
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [mcpStatuses, setMcpStatuses] = useState<Record<string, 'connected' | 'disconnected' | 'connecting'>>({});
  const [showMcpPanel, setShowMcpPanel] = useState(false);
  
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    // Listen for events from main process (only available inside Electron)
    if (!window.electron?.onAgentEvent) return;
    window.electron.onAgentEvent((event: any) => {
      setMessages(prev => {
        const newMsgs = [...prev];
        const lastMsg = newMsgs[newMsgs.length - 1];
        
        if (event.type === 'message') {
            if (lastMsg && lastMsg.role === 'assistant') {
                lastMsg.content += event.content;
            } else {
                newMsgs.push({ id: Date.now().toString(), role: 'assistant', content: event.content });
            }
        } else if (event.type === 'tool_call') {
            if (lastMsg && lastMsg.role === 'assistant') {
                lastMsg.toolCalls = lastMsg.toolCalls || [];
                lastMsg.toolCalls.push(event);
            } else {
                newMsgs.push({ id: Date.now().toString(), role: 'assistant', content: '', toolCalls: [event] });
            }
        } else if (event.type === 'tool_result') {
            if (lastMsg && lastMsg.toolCalls) {
                const call = [...lastMsg.toolCalls].reverse().find((c: any) => c.name === event.name && !c.result);
                if (call) call.result = event.result;
            }
        } else if (event.type === 'error') {
            newMsgs.push({ id: Date.now().toString(), role: 'assistant', content: `Error: ${event.content}` });
        } else if (event.type === 'done') {
            setIsTyping(false);
        }
        return newMsgs;
      });
    });
  }, []);

  const selectWorkspace = async () => {
    if (!window.electron?.selectFolder) return;
    const path = await window.electron.selectFolder();
    if (path) setWorkspace(path);
  };

  const handleSend = () => {
    if (!input.trim() || !workspace || !settings.apiKey) return;
    
    const newMsg: ChatMessage = { id: Date.now().toString(), role: 'user', content: input };
    setMessages(prev => [...prev, newMsg]);
    setInput('');
    setIsTyping(true);
    
    window.electron?.sendPrompt(input, workspace, settings);
  };

  const handleSaveSettings = () => {
    localStorage.setItem('moon-agent-settings', JSON.stringify(settings));
    setShowSettings(false);
  };

  /* ---- Skills handlers ---- */
  const handleToggleSkill = (skill: SkillEntry) => {
    setActiveSkills((prev) => {
      const exists = prev.find((s) => s.id === skill.id);
      if (exists) return prev.filter((s) => s.id !== skill.id);
      return [...prev, { id: skill.id, name: skill.name, description: skill.description }];
    });
  };

  const handleRemoveSkill = (id: string) => {
    setActiveSkills((prev) => prev.filter((s) => s.id !== id));
  };

  /* ---- MCP handlers ---- */
  const handleToggleMcp = (server: McpServerEntry) => {
    const isConnected = mcpServers.some((s) => s.id === server.id);
    if (isConnected) {
      setMcpServers((prev) => prev.filter((s) => s.id !== server.id));
      setMcpStatuses((prev) => {
        const next = { ...prev };
        delete next[server.id];
        return next;
      });
    } else {
      // Simulate connection
      setMcpStatuses((prev) => ({ ...prev, [server.id]: 'connecting' }));
      setTimeout(() => {
        setMcpServers((prev) => [
          ...prev,
          { id: server.id, name: server.name, status: 'connected', tools: server.tools },
        ]);
        setMcpStatuses((prev) => ({ ...prev, [server.id]: 'connected' }));
      }, 800);
    }
  };

  const handleDisconnectMcp = (id: string) => {
    setMcpServers((prev) => prev.filter((s) => s.id !== id));
    setMcpStatuses((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const providerOptions = [
    { label: 'OpenAI', defaultBase: '', defaultModel: 'gpt-4o' },
    { label: 'Zhipu AI (GLM)', defaultBase: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4' },
    { label: 'OpenRouter', defaultBase: 'https://openrouter.ai/api/v1', defaultModel: 'anthropic/claude-3-opus' },
    { label: 'Cloudflare Workers AI', defaultBase: 'https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1', defaultModel: '@cf/meta/llama-3-8b-instruct' },
    { label: 'Anthropic', defaultBase: 'https://api.anthropic.com/v1', defaultModel: 'claude-3-opus-20240229' },
    { label: 'Custom (OpenAI-Compatible)', defaultBase: '', defaultModel: '' }
  ];

  const inputDisabled = !workspace || isTyping || !settings.apiKey;
  const inputPlaceholder = !workspace
    ? 'Select a workspace to get started...'
    : !settings.apiKey
      ? 'Configure your API key in Settings...'
      : 'Ask Moon Agent anything. Shift+Enter for new line.';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '20px', paddingTop: '40px', position: 'relative' }}>
      
      {/* Settings Modal */}
      {showSettings && (
        <div className="modal-overlay">
          <div className="glass-panel modal-content">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}>Settings</h3>
                <X size={18} style={{ cursor: 'pointer' }} onClick={() => setShowSettings(false)} />
            </div>
            
            <div>
                <label>Provider</label>
                <select 
                    value={settings.provider} 
                    onChange={e => {
                        const opt = providerOptions.find(p => p.label === e.target.value);
                        setSettings({ ...settings, provider: e.target.value, baseUrl: opt?.defaultBase || '', model: opt?.defaultModel || '' });
                    }}
                >
                    {providerOptions.map(p => (
                        <option key={p.label} value={p.label}>{p.label}</option>
                    ))}
                </select>
            </div>

            <div>
                <label>API Key</label>
                <input 
                    type="password" 
                    value={settings.apiKey} 
                    onChange={e => setSettings({ ...settings, apiKey: e.target.value })} 
                    placeholder="Enter your API Key..."
                />
            </div>

            <div>
                <label>Model Name</label>
                <input 
                    type="text" 
                    value={settings.model} 
                    onChange={e => setSettings({ ...settings, model: e.target.value })} 
                    placeholder="e.g. gpt-4o"
                />
            </div>

            <div>
                <label>Base URL (Optional)</label>
                <input 
                    type="text" 
                    value={settings.baseUrl} 
                    onChange={e => setSettings({ ...settings, baseUrl: e.target.value })} 
                    placeholder="Override endpoint URL..."
                />
            </div>

            <button 
                onClick={handleSaveSettings}
                style={{ 
                    background: 'var(--accent-color)', 
                    color: '#000', 
                    border: 'none', 
                    borderRadius: '8px', 
                    padding: '10px',
                    cursor: 'pointer',
                    fontWeight: 600,
                    marginTop: '10px'
                }}
            >
                Save Preferences
            </button>
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
            messages.map((msg, i) => (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
                    <div style={{ 
                        background: msg.role === 'user' ? 'var(--accent-color)' : 'rgba(255,255,255,0.05)',
                        color: msg.role === 'user' ? '#000' : 'var(--text-primary)',
                        padding: '12px 16px',
                        borderRadius: '12px',
                        maxWidth: '80%',
                        lineHeight: '1.5'
                    }}>
                        {msg.content}
                    </div>
                    
                    {/* Tool Calls */}
                    {msg.toolCalls && msg.toolCalls.map((tool: any, j: number) => (
                        <div key={j} style={{ 
                            marginTop: '8px', 
                            background: 'rgba(0,0,0,0.3)', 
                            border: '1px solid var(--border-color)',
                            borderRadius: '8px',
                            padding: '8px 12px',
                            fontSize: '12px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            color: 'var(--text-secondary)'
                        }}>
                            {tool.name === 'run_command' ? <Terminal size={14} /> : <FileEdit size={14} />}
                            <span>{tool.result ? 'Ran' : 'Executing'} <strong>{tool.name}</strong>{tool.result ? '' : '...'}</span>
                        </div>
                    ))}
                </div>
            ))
        )}
        {isTyping && (
            <div style={{ color: 'var(--text-secondary)', fontSize: '14px', padding: '10px' }}>
                Agent is thinking...
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
        />
      </div>
    </div>
  );
}
