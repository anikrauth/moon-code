// @ts-nocheck
import React, { useState, useEffect, useRef } from 'react';
import { FolderOpen, Plus } from 'lucide-react';
import RichInput, { SkillItem } from './RichInput';
import Sidebar from './Sidebar';
import { SKILL_CATALOG } from '../shared/skillCatalog';
import { resolveLimits } from '../shared/modelLimits';
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
    preview = args.command ?? args.filePath ?? args.dirPath ?? args.task ?? args.pattern ?? args.skill_id ?? '';
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
  const [statusText, setStatusText] = useState<string | null>(null);
  const [config, setConfig] = useState<any>(null);

  /* ---- Sidebar state ---- */
  const [sidebarTab, setSidebarTab] = useState<string | null>('sessions');
  const [skillInstallKey, setSkillInstallKey] = useState(0);

  function StatusIndicator({ text }: { text: string | null }) {
    const verbs = ['Thinking', 'Pondering', 'Simmering', 'Cogitating', 'Synthesizing'];
    const [verb, setVerb] = useState(verbs[0]);
    const [frame, setFrame] = useState(0);

    useEffect(() => {
      setVerb(verbs[Math.floor(Math.random() * verbs.length)]);
      const vTimer = setInterval(() => {
        setVerb(verbs[Math.floor(Math.random() * verbs.length)]);
      }, 3000);
      const sTimer = setInterval(() => {
        setFrame((f) => (f + 1) % 10);
      }, 100);
      return () => { clearInterval(vTimer); clearInterval(sTimer); };
    }, []);

    const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][frame];
    const label = text ?? `${verb}…`;

    return (
      <div className="status-indicator">
        <span className="status-spinner">{spinner}</span>
        <span className="status-label">{label}</span>
        <span className="status-esc">esc to interrupt</span>
      </div>
    );
  }

  /* ---- Skills state ---- */
  const [activeSkills, setActiveSkills] = useState<SkillItem[]>([]);
  const [discoveredSkills, setDiscoveredSkills] = useState<any[]>([]);
  const [invokedSkills, setInvokedSkills] = useState<string[]>([]);

  /* ---- MCP state ---- */
  const [permissionQueue, setPermissionQueue] = useState<any[]>([]);
  const [mcpData, setMcpData] = useState<any>({ servers: [], statuses: {} });

  /* ---- Sessions state ---- */
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [sessionList, setSessionList] = useState<any[]>([]);

  /* ---- Usage / context-limit state ----
     Refs are the source of truth: the agent-event listener registers once and
     must both read and write these synchronously (a `usage` event is followed
     by a `done` event that persists them before React re-renders). State
     mirrors the refs for display. */
  const EMPTY_SESSION_USAGE = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, turns: 0 };
  const [sessionUsage, setSessionUsage] = useState(EMPTY_SESSION_USAGE);
  const sessionUsageRef = useRef(EMPTY_SESSION_USAGE);
  const [contextInfo, setContextInfo] = useState<any>(null);
  const contextInfoRef = useRef<any>(null);
  const setSessionUsageBoth = (u: any) => { sessionUsageRef.current = u; setSessionUsage(u); };
  const setContextInfoBoth = (c: any) => { contextInfoRef.current = c; setContextInfo(c); };

  const applyConfig = (c: any) => {
    setConfig(c);
    setActiveSkills(
      c.activeSkillIds
        .map((id: string) => SKILL_CATALOG.find((s) => s.id === id))
        .filter(Boolean)
        .map((s: any) => ({ id: s.id, name: s.name, description: s.description }))
    );
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

  /* Saves are serialized through this chain: a fast second turn could
     otherwise start its save before the first save's returned id has been
     adopted, so both would read sessionId: null and create duplicates. */
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const sessionEpochRef = useRef(0);

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
            const epoch = sessionEpochRef.current;
            const payload = {
              title: firstUser.content.trim().slice(0, 60),
              workspace: snap.workspace,
              messages: snap.messages,
              history: event.history,
              usage: { context: contextInfoRef.current, session: sessionUsageRef.current },
            };
            saveChainRef.current = saveChainRef.current
              .then(async () => {
                // Read the sessionId at execution time: a prior queued save has
                // already written its adopted id into the ref synchronously,
                // so this save updates that session instead of duplicating it.
                const id = await window.electron?.saveSession({ ...payload, id: sessionSnapshotRef.current.sessionId ?? undefined });
                // The save itself still writes — that's correct, the completed
                // turn belongs to the old session — only ADOPTION into current
                // UI state is skipped if a New Chat / session switch happened
                // after this save was enqueued (stale id would otherwise leak
                // into the fresh chat and get silently overwritten next turn).
                if (id && epoch === sessionEpochRef.current) {
                  sessionSnapshotRef.current.sessionId = id;
                  setCurrentSessionId(id);
                }
              })
              .catch(() => { /* persistence must never break the UI */ });
          }
        }
        return;
      }
      if (event.type === 'usage') {
        if (event.usage) {
          const prev = sessionUsageRef.current;
          const next = {
            inputTokens: prev.inputTokens + (event.usage.inputTokens ?? 0),
            outputTokens: prev.outputTokens + (event.usage.outputTokens ?? 0),
            cachedInputTokens: prev.cachedInputTokens + (event.usage.cachedInputTokens ?? 0),
            turns: prev.turns + ((event.agent ?? 'main') === 'main' ? 1 : 0),
          };
          sessionUsageRef.current = next;
          setSessionUsage(next);
        }
        // Context fullness only tracks the main agent's final call; subagents
        // run their own prompts and only matter for session accounting above.
        if ((event.agent ?? 'main') === 'main' && event.lastStep && event.limits) {
          const info = {
            lastInputTokens: event.lastStep.inputTokens,
            lastOutputTokens: event.lastStep.outputTokens,
            contextWindow: event.limits.contextWindow,
            maxOutputTokens: event.limits.maxOutputTokens,
            pct: event.contextPct ?? 0,
            estimated: false,
          };
          contextInfoRef.current = info;
          setContextInfo(info);
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
          if (event.name === 'skill') {
            try {
              const { skill_id } = JSON.parse(event.arguments ?? '{}');
              if (skill_id) setInvokedSkills((prev) => (prev.includes(skill_id) ? prev : [...prev, skill_id]));
            } catch { /* unparseable arguments — skip badge update */ }
          }
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
      window.electron?.mcpList?.().then((d: any) => d && setMcpData(d));
      window.electron?.listSessions?.().then((list: any) => setSessionList(list ?? []));
      window.electron?.onMcpEvent?.((evt: any) => {
        setMcpData((prev: any) => ({ ...prev, statuses: { ...prev.statuses, [evt.id]: { status: evt.status, toolCount: evt.toolCount, message: evt.message } } }));
      });
    })();
  }, []);

  const refreshDiscoveredSkills = () => {
    if (!workspace) { setDiscoveredSkills([]); return; }
    window.electron?.discoverSkills?.(workspace).then((list: any) => setDiscoveredSkills(list ?? []));
  };

  useEffect(() => {
    refreshDiscoveredSkills();
  }, [workspace]);

  useEffect(() => {
    if (sidebarTab === 'skills') refreshDiscoveredSkills();
    if (sidebarTab === 'mcp') window.electron?.mcpList?.().then((d: any) => d && setMcpData(d));
    if (sidebarTab === 'sessions') window.electron?.listSessions?.().then((list: any) => setSessionList(list ?? []));
  }, [sidebarTab]);

  const startNewChat = () => {
    sessionEpochRef.current += 1;
    setMessages([]);
    setHistory(undefined);
    setCurrentSessionId(null);
    setSessionUsageBoth(EMPTY_SESSION_USAGE);
    setContextInfoBoth(null);
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
  const activeLimits = resolveLimits(activeProfile?.model, activeProfile ?? undefined);

  /* Live context display: real reported usage when we have it, otherwise a
     chars/4 estimate of the pending history (marked with ~ in the UI). */
  const estimateHistoryTokens = (h: any[] | undefined) =>
    (h ?? []).reduce((sum: number, m: any) =>
      sum + Math.ceil((typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')).length / 4), 0);
  const displayContext = contextInfo ?? (history?.length ? {
    lastInputTokens: estimateHistoryTokens(history),
    lastOutputTokens: 0,
    contextWindow: activeLimits.contextWindow,
    maxOutputTokens: activeLimits.maxOutputTokens,
    pct: Math.min(1, estimateHistoryTokens(history) / activeLimits.contextWindow),
    estimated: true,
  } : null);

  const connectedMcpServers = mcpData.servers
    .filter((s: any) => mcpData.statuses[s.id]?.status === 'connected')
    .map((s: any) => ({ id: s.id, name: s.name, status: 'connected', tools: mcpData.statuses[s.id]?.toolCount }));

  const handleSend = () => {
    if (!input.trim() || !workspace || !activeProfile?.hasKey) return;

    const newMsg: ChatMessage = { id: Date.now().toString(), role: 'user', content: input };
    setMessages(prev => [...prev, newMsg]);
    setInput('');
    setIsTyping(true);
    setStatusText(null);

    window.electron?.sendPrompt(input, workspace, config.activeProfileId, history, {
      // Real usage only — an estimate as the compaction trigger could compact
      // too early (or too late) when the provider never reports usage.
      lastInputTokens: contextInfo && !contextInfo.estimated ? contextInfo.lastInputTokens : undefined,
    });
  };

  /* ---- Skills handlers ---- */
  const handleToggleSkill = (skill: any) => {
    setActiveSkills((prev) => {
      const exists = prev.find((s) => s.id === skill.id);
      const next = exists
        ? prev.filter((s) => s.id !== skill.id)
        : [...prev, { id: skill.id, name: skill.name, description: skill.description }];
      window.electron?.setSkillIds(next.map((s) => s.id));
      return next;
    });
  };

  const handleSendWithSkillContent = (userPrompt: string, skillContent: string) => {
    if (!workspace || !activeProfile?.hasKey) return;
    const newMsg: ChatMessage = { id: Date.now().toString(), role: 'user', content: userPrompt };
    setMessages(prev => [...prev, newMsg]);
    setInput('');
    setIsTyping(true);
    setStatusText(null);
    window.electron?.sendPrompt(userPrompt, workspace, config.activeProfileId, history, {
      lastInputTokens: contextInfo && !contextInfo.estimated ? contextInfo.lastInputTokens : undefined,
      skillContent,
    });
  };

  const invokeSkillById = async (id: string, arg?: string) => {
    if (!workspace) return;
    const result = await window.electron?.readSkill(id, workspace);
    if (!result) { appendLocalNote(`Skill "${id}" not found.`); return; }
    setInvokedSkills((prev) => [...new Set([...prev, id])]);
    const userPrompt = (arg ?? '').trim() || `Run the ${id} skill.`;
    handleSendWithSkillContent(userPrompt, result.content);
  };

  const handleCreateSkill = async () => {
    if (!workspace) { appendLocalNote('Select a workspace first.'); return; }
    const name = window.prompt('Skill name (used as /command and directory name):');
    const id = name?.trim();
    if (!id) return;
    if (!/^[a-z0-9-]+$/.test(id)) {
      appendLocalNote('Skill name must be lowercase letters, numbers, and hyphens only (e.g. "my-skill").');
      return;
    }
    if (discoveredSkills.some((s) => s.id === id)) {
      appendLocalNote(`Skill "${id}" already exists. Delete it first or use a different name.`);
      return;
    }
    const description = window.prompt('One-line description:') ?? '';
    const scope = window.confirm('OK = save to this project (.moon/skills). Cancel = save to your personal (~/.moon/skills).') ? 'project' : 'personal';
    const escapedDesc = description.trim().replace(/"/g, '\\"');
    const content = `---\nname: ${id}\ndescription: "${escapedDesc}"\n---\n# ${id}\n\nDescribe what this skill should do.\n`;
    const result = await window.electron?.createSkill(id, content, scope, workspace);
    if (result?.success && result.skill) {
      appendLocalNote(`Skill "${result.skill.id}" created in ${scope === 'personal' ? '~/.moon/skills' : '.moon/skills'}.`);
      refreshDiscoveredSkills();
      setSidebarTab('skills');
      setSkillInstallKey((k) => k + 1);
    } else {
      appendLocalNote(`Failed to create skill: ${result?.error ?? 'unknown error'}`);
    }
  };

  const handleInstallSkill = async () => {
    if (!workspace) { appendLocalNote('Select a workspace first.'); return; }
    const sourcePath = await window.electron?.selectSkill?.();
    if (!sourcePath) return;
    // Default disk installs to personal/global so they work across workspaces.
    const scope = window.confirm('OK = install to this project (.moon/skills). Cancel = install globally (~/.moon/skills).') ? 'project' : 'personal';
    const result = await window.electron?.installSkill?.(sourcePath, scope, workspace);
    if (result?.success && result.skill) {
      appendLocalNote(`Skill "${result.skill.id}" installed in ${scope === 'personal' ? '~/.moon/skills' : '.moon/skills'}.`);
      refreshDiscoveredSkills();
      setSidebarTab('skills');
      setSkillInstallKey((k) => k + 1);
    } else {
      appendLocalNote(`Failed to install skill: ${result?.error ?? 'Select a SKILL.md file or a directory containing one.'}`);
    }
  };

  const handleInstallMarketplaceSkill = async (skillId: string) => {
    if (!workspace) { appendLocalNote('Select a workspace first.'); return; }
    const result = await window.electron?.installMarketplaceSkill?.(skillId, workspace);
    if (result?.success && result.skill) {
      appendLocalNote(`Marketplace skill "${result.skill.id}" installed globally to ~/.moon/skills.`);
      refreshDiscoveredSkills();
      setSidebarTab('skills');
      setSkillInstallKey((k) => k + 1);
    } else {
      appendLocalNote(`Failed to install marketplace skill "${skillId}": ${result?.error ?? 'unknown error'}`);
    }
  };

  const handleInstallSkillFromUrl = async (url: string) => {
    if (!workspace) { appendLocalNote('Select a workspace first.'); return; }
    if (!url.trim()) return;
    const result = await window.electron?.installSkillFromUrl?.(url.trim(), workspace);
    if (result?.success && result.skill) {
      appendLocalNote(`Skill "${result.skill.id}" installed globally from URL.`);
      refreshDiscoveredSkills();
      setSidebarTab('skills');
      setSkillInstallKey((k) => k + 1);
    } else {
      appendLocalNote(`Failed to install skill from URL: ${result?.error ?? 'Must be a raw SKILL.md with YAML frontmatter.'}`);
    }
  };

  /* ---- Sessions handlers ---- */
  const handleSelectSession = async (id: string) => {
    const s = await window.electron?.getSession(id);
    if (!s) return;
    sessionEpochRef.current += 1;
    setWorkspace(s.workspace);
    setMessages(s.messages ?? []);
    setHistory(s.history ?? undefined);
    setCurrentSessionId(s.id);
    setSidebarTab(null);
    // Restore persisted usage; absent → null/zeros, and the display layer
    // falls back to a live chars/4 estimate of the restored history.
    setSessionUsageBoth(s.usage?.session ?? EMPTY_SESSION_USAGE);
    setContextInfoBoth(s.usage?.context ?? null);
  };

  const handleDeleteSession = async (id: string) => {
    const list = await window.electron?.deleteSession(id);
    setSessionList(list ?? []);
    if (id === currentSessionId) {
      sessionEpochRef.current += 1;
      setCurrentSessionId(null);
    }
  };

  /* ---- MCP handlers ---- */
  const handleAddMcpPreset = (preset: any) => {
    const args = preset.args.map((a: string) => (a === '{workspace}' ? (workspace ?? '~') : a));
    window.electron?.upsertMcpServer({ name: preset.name, transport: 'stdio', command: preset.command, args })
      .then((d: any) => d && setMcpData(d));
  };

  /* ---- Slash commands ---- */
  const appendLocalNote = (content: string) => {
    setMessages((prev) => [...prev, { id: Date.now().toString(), role: 'assistant', content }]);
  };

  const compactNow = async () => {
    if (isTyping) return;
    if (!activeProfile?.hasKey) { appendLocalNote('No active model profile with an API key — configure one in Settings.'); return; }
    if (!history || history.length <= 2) { appendLocalNote('Nothing to compact yet.'); return; }
    const before = history.length;
    setIsTyping(true);
    try {
      const res = await window.electron?.compactNow(config.activeProfileId, history);
      if (res?.ok) {
        setHistory(res.history);
        // The pre-compaction reported tokens are stale now; drop to an
        // estimate so the banner clears and the stale count is never sent
        // back as a compaction trigger.
        const est = estimateHistoryTokens(res.history);
        setContextInfoBoth({
          lastInputTokens: est,
          lastOutputTokens: 0,
          contextWindow: activeLimits.contextWindow,
          maxOutputTokens: activeLimits.maxOutputTokens,
          pct: Math.min(1, est / activeLimits.contextWindow),
          estimated: true,
        });
        appendLocalNote(`History compacted: ${before} → ${res.history.length} messages.`);
      } else {
        appendLocalNote(`Compaction failed${res?.error ? `: ${res.error}` : '.'}`);
      }
    } finally {
      setIsTyping(false);
    }
  };

  const fmtTok = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : `${n}`);
  const contextReport = () => {
    if (!displayContext) return 'Context: empty — no conversation yet.';
    const used = displayContext.lastInputTokens + displayContext.lastOutputTokens;
    const approx = displayContext.estimated ? '~' : '';
    return `Context: ${approx}${fmtTok(used)} / ${fmtTok(displayContext.contextWindow)} tokens (${Math.round(displayContext.pct * 100)}% ${displayContext.estimated ? 'estimated' : 'reported'}).`;
  };
  const usageReport = () => {
    const overridden = (field: string) => (activeProfile?.[field] ? ' (override)' : '');
    const lines = [
      `Model: ${activeProfile?.model ?? '(none)'} — context window ${activeLimits.contextWindow.toLocaleString()}${overridden('contextWindow')}, max output ${activeLimits.maxOutputTokens.toLocaleString()}${overridden('maxOutputTokens')}.`,
      contextReport(),
    ];
    if (displayContext && !displayContext.estimated) {
      lines.push(`Last turn: ${fmtTok(displayContext.lastInputTokens)} in · ${fmtTok(displayContext.lastOutputTokens)} out.`);
    }
    lines.push(`Session: ${sessionUsage.turns} turn${sessionUsage.turns === 1 ? '' : 's'} · ${fmtTok(sessionUsage.inputTokens)} in · ${fmtTok(sessionUsage.outputTokens)} out · ${fmtTok(sessionUsage.cachedInputTokens)} cached.`);
    const p = activeLimits.pricing;
    if (p && (sessionUsage.inputTokens || sessionUsage.outputTokens)) {
      const cost = ((sessionUsage.inputTokens - sessionUsage.cachedInputTokens) * p.inPerMTok
        + sessionUsage.cachedInputTokens * (p.cachedInPerMTok ?? p.inPerMTok)
        + sessionUsage.outputTokens * p.outPerMTok) / 1e6;
      lines.push(`Est. session cost: $${cost.toFixed(4)}.`);
    }
    return lines.join('\n');
  };

  const baseCommands = [
    { name: 'clear', description: 'Start a new chat', run: () => startNewChat() },
    { name: 'compact', description: 'Compact conversation history now', run: () => compactNow() },
    { name: 'usage', description: 'Show token usage, limits, and cost', run: () => appendLocalNote(usageReport()) },
    { name: 'context', description: 'Show context window usage', run: () => appendLocalNote(contextReport()) },
    {
      name: 'model', description: 'Switch model profile: /model <name>', run: (arg?: string) => {
        const profiles = config?.profiles ?? [];
        if (arg) {
          const match = profiles.find((p: any) => p.name.toLowerCase().includes(arg.toLowerCase()));
          if (match) {
            window.electron?.setActiveProfile(match.id).then(setConfig);
            appendLocalNote(`Model switched to ${match.name}.`);
            return;
          }
        }
        appendLocalNote(`Profiles: ${profiles.map((p: any) => p.name).join(', ') || '(none configured)'}. Usage: /model <name>.`);
      }
    },
    { name: 'skills', description: 'Open the skills panel', run: () => setSidebarTab('skills') },
    { name: 'sessions', description: 'Open saved sessions', run: () => setSidebarTab('sessions') },
    { name: 'mcp', description: 'Open MCP servers', run: () => setSidebarTab('mcp') },
    { name: 'settings', description: 'Open settings', run: () => setSidebarTab('settings') },
    {
      name: 'debug', description: 'Show diagnostic info about skills, workspace, and config', run: () => {
        const lines = [
          `workspace: ${workspace ?? '(none)'}`,
          `activeProfile: ${activeProfile?.name ?? '(none)'}`,
          `discoveredSkills: ${discoveredSkills.map((s: any) => s.id).join(', ') || '(none)'}`,
          `invokedSkills: ${invokedSkills.join(', ') || '(none)'}`,
          `activeSkills: ${activeSkills.map((s: any) => s.id).join(', ') || '(none)'}`,
          `electron.createSkill: ${typeof window.electron?.createSkill}`,
          `electron.installSkill: ${typeof window.electron?.installSkill}`,
          `electron.installMarketplaceSkill: ${typeof window.electron?.installMarketplaceSkill}`,
          `electron.installSkillFromUrl: ${typeof window.electron?.installSkillFromUrl}`,
        ];
        appendLocalNote(lines.join('\n'));
      }
    },
  ];
  const skillCommands = discoveredSkills
    .filter((s: any) => s.userInvocable)
    .map((s: any) => ({
      name: s.id,
      description: (s.description ?? '').slice(0, 80),
      run: (arg?: string) => invokeSkillById(s.id, arg),
    }));

  const slashCommands = [
    ...baseCommands,
    ...skillCommands,
    {
      name: 'skills', description: 'List installed skills and open the skills panel', run: () => {
        const lines = discoveredSkills.length > 0
          ? discoveredSkills.map((s: any) => `/${s.id} — ${(s.description ?? '').slice(0, 80)}`).join('\n')
          : 'No installed skills found. Open the Skills panel to create or install one.';
        appendLocalNote(`Installed skills:\n${lines}`);
        setSidebarTab('skills');
      }
    },
    {
      name: 'help', description: 'List available commands', run: () =>
        appendLocalNote(baseCommands.concat(skillCommands).concat([{ name: 'skills', description: 'List installed skills' }, { name: 'help', description: 'List available commands' }])
          .map((c: any) => `/${c.name} — ${c.description}`).join('\n'))
    },
  ];

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

  const inputDisabled = !workspace || isTyping || !activeProfile?.hasKey;
  const inputPlaceholder = !workspace
    ? 'Select a workspace to get started...'
    : !activeProfile?.hasKey
      ? 'Add a model profile in Settings…'
      : 'Ask Moon Code anything. Shift+Enter for new line.';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '20px', paddingTop: '40px', position: 'relative', boxSizing: 'border-box' }}>

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
                  borderRadius: 'var(--radius-md)',
                  fontWeight: 600
                }}
              >
                Always allow ({permissionQueue[0].name})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sidebar + main column */}
      <div style={{ display: 'flex', flexDirection: 'row', flex: 1, minHeight: 0, gap: '20px' }}>

      <Sidebar
        activeTab={sidebarTab}
        onTabChange={setSidebarTab}
        activeSkillIds={activeSkills.map((s) => s.id)}
        onToggleSkill={handleToggleSkill}
        discoveredSkills={discoveredSkills}
        invokedSkillIds={invokedSkills}
        onInvokeSkill={(id: string) => { invokeSkillById(id); setSidebarTab(null); }}
        onCreateSkill={handleCreateSkill}
        onInstallSkill={handleInstallSkill}
        onInstallMarketplaceSkill={handleInstallMarketplaceSkill}
        onInstallSkillFromUrl={handleInstallSkillFromUrl}
        skillInstallKey={skillInstallKey}
        mcpData={mcpData}
        busy={isTyping}
        onConnectMcpServer={(id: string) => window.electron?.connectMcp(id).then(setMcpData)}
        onDisconnectMcpServer={(id: string) => window.electron?.disconnectMcp(id).then(setMcpData)}
        onSaveMcpServer={(def: any, secrets: any) => window.electron?.upsertMcpServer(def, secrets).then(setMcpData)}
        onDeleteMcpServer={(id: string) => window.electron?.deleteMcpServer(id).then(setMcpData)}
        onAddMcpPreset={handleAddMcpPreset}
        sessions={sessionList}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
        config={config}
        onSetActiveProfile={(id: string) => window.electron?.setActiveProfile(id).then(setConfig)}
        onSaveProfile={(profile: any, apiKey?: string) => window.electron?.upsertProfile(profile, apiKey).then(setConfig)}
        onDeleteProfile={(id: string) => window.electron?.deleteProfile(id).then(setConfig)}
        sessionUsage={sessionUsage}
        contextInfo={displayContext}
        activeProfile={activeProfile}
        activeLimits={activeLimits}
      />

      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <img src="./moon-logo.png" width={28} height={28} alt="Moon Code" />
          <h1 style={{ margin: 0, fontSize: '16px', fontWeight: 700, letterSpacing: '-0.02em' }}>Moon Code</h1>
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
            onClick={startNewChat}
            className="glass-panel"
            style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', color: 'var(--text-primary)', cursor: 'pointer' }}
            title="New Chat"
          >
            <Plus size={16} />
          </button>
        </div>
      </div>

      {/* Chat Area */}
      <div className="chat-container glass-panel" style={{ flexGrow: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
        {messages.length === 0 ? (
          <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-secondary)' }}>
            <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)' }}>How can I help you code today?</h2>
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
                    lineHeight: '1.5',
                    whiteSpace: 'pre-wrap'
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
        {isTyping && <StatusIndicator text={statusText} />}
        <div ref={chatEndRef} />
      </div>

      {/* Context-limit warning banner */}
      {displayContext && displayContext.pct >= 0.8 && !isTyping && (
        <div className="glass-panel context-warning-banner">
          <span>
            Context is {Math.round(displayContext.pct * 100)}%{displayContext.estimated ? ' (estimated)' : ''} full — compaction will run automatically soon.
          </span>
          <button className="context-warning-action" onClick={() => compactNow()}>Compact now</button>
        </div>
      )}

      {/* Rich Input */}
      <div style={{ marginTop: displayContext && displayContext.pct >= 0.8 && !isTyping ? '8px' : '20px' }}>
        <RichInput
          value={input}
          onChange={setInput}
          onSend={handleSend}
          disabled={inputDisabled}
          placeholder={inputPlaceholder}
          skills={activeSkills}
          onAddSkill={() => setSidebarTab('skills')}
          mcpServers={connectedMcpServers}
          onConnectMcp={() => setSidebarTab('mcp')}
          profiles={config?.profiles ?? []}
          activeProfileId={config?.activeProfileId ?? null}
          onSelectProfile={(id) => window.electron?.setActiveProfile(id).then(setConfig)}
          busy={isTyping}
          onStop={() => window.electron?.cancelPrompt()}
          commands={slashCommands}
          onUnknownCommand={(name, arg) => {
            const known = slashCommands.find((c) => c.name === name);
            if (known) {
              known.run(arg);
            } else {
              appendLocalNote(`Unknown command /${name}. Type /help for available commands.`);
            }
          }}
          contextInfo={displayContext}
          capabilities={activeLimits.capabilities}
        />
      </div>

      </div>

      </div>
    </div>
  );
}
