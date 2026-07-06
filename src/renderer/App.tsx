// @ts-nocheck
import React, { useState, useEffect, useRef } from 'react';
import RichInput from './features/chat-input/RichInput';
import TaskSidebar from './widgets/task-sidebar/TaskSidebar';
import TopBar from './widgets/top-bar/TopBar';
import RightPanel from './widgets/right-panel/RightPanel';
import OverlayModal from './widgets/overlay-modal/OverlayModal';
import { ToolChip, TurnSummaryCard } from './features/tool-chips/ToolChips';
const SkillsPanel = React.lazy(() => import('./features/skills-panel/SkillsPanel'));
const McpPanel = React.lazy(() => import('./features/mcp-panel/McpPanel'));
const SettingsPanel = React.lazy(() => import('./features/settings-panel/SettingsPanel'));
const UsagePanel = React.lazy(() => import('./features/usage-panel/UsagePanel'));
import { resolveLimits } from '@shared/lib/modelLimits';
import { JSONUIProvider, Renderer } from '@json-render/react';
import { registry } from './entities/ui-spec/uiRegistry';
import { parseAssistantContent } from './entities/chat-message/parseAssistantContent';
import { parseRenderUiSpec } from '@shared/lib/renderUiSpec';
import Markdown, { setLinkWorkspace } from './entities/chat-message/Markdown';
import { MessageActions } from './entities/chat-message/MessageActions';
import PermissionRequest from './features/permission-request/PermissionRequest';
import QuestionPrompt from './features/question-prompt/QuestionPrompt';

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

/* Assistant answers are markdown; structured UI arrives via the render_ui
   tool (UiWidgetBlock). The spec branch here only serves sessions persisted
   before that change, whose message content is raw SpecStream JSONL — those
   are settled (never streaming), so no partial-spec handling is needed. */
function AssistantContent({ content, streaming }: { content: string; streaming: boolean }) {
  if (!streaming && content.trimStart().startsWith('{')) {
    const spec = parseAssistantContent(content);
    if (spec) {
      return (
        <SpecErrorBoundary fallback={<Markdown>{content}</Markdown>}>
          <JSONUIProvider registry={registry} initialState={spec.state ?? {}}>
            <Renderer spec={spec} registry={registry} />
          </JSONUIProvider>
        </SpecErrorBoundary>
      );
    }
  }
  return <Markdown streaming={streaming}>{content}</Markdown>;
}

/* render_ui tool calls render as an inline widget card instead of a collapsed
   activity row. Invalid specs (the model gets an error result and retries)
   fall back to the activity row so the user sees the error, not a broken card. */
function UiWidgetBlock({ tool }: { tool: any }) {
  const parsed = React.useMemo(() => {
    try {
      return parseRenderUiSpec(JSON.parse(tool.arguments ?? '{}').spec ?? '');
    } catch (e) {
      console.warn('[moon] render_ui arguments unparseable', e);
      return { ok: false, error: 'unparseable arguments' };
    }
  }, [tool.arguments]);
  if (!parsed.ok) return <ToolChip tool={tool} />;
  return (
    <div className="ui-widget-card">
      <SpecErrorBoundary fallback={<pre className="md-pre">{tool.arguments}</pre>}>
        <JSONUIProvider registry={registry} initialState={parsed.spec.state ?? {}}>
          <Renderer spec={parsed.spec} registry={registry} />
        </JSONUIProvider>
      </SpecErrorBoundary>
    </div>
  );
}

/* Message ids are React keys: Date.now() alone collides when two messages are
   created in the same millisecond (e.g. error + note), so add a counter. */
let msgSeq = 0;
const nextMsgId = () => `m${Date.now().toString(36)}-${++msgSeq}`;

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: any[];
  ts?: number;
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

  /* ---- Overlay-modal state (Skills/MCP/Settings/Usage) ---- */
  const [activeModal, setActiveModal] = useState<string | null>(null);
  const [skillInstallKey, setSkillInstallKey] = useState(0);

  /* ---- Right-panel state (git + goal + progress) ---- */
  const [rightPanelOpen, setRightPanelOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('moon-right-panel') !== '0'; } catch { return true; }
  });
  const toggleRightPanel = () => setRightPanelOpen((o) => {
    const next = !o;
    try { localStorage.setItem('moon-right-panel', next ? '1' : '0'); } catch { /* ignore */ }
    return next;
  });
  const [gitSnapshot, setGitSnapshot] = useState<any>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [currentCreatedAt, setCurrentCreatedAt] = useState<number>(() => Date.now());

  /* Progress (from the set_progress tool). Ref-mirrored because the `done`
     save handler runs in the once-registered listener and must read it
     synchronously, same pattern as sessionUsageRef. */
  const [progress, setProgress] = useState<any>(null);
  const progressRef = useRef<any>(null);
  const setProgressBoth = (p: any) => { progressRef.current = p; setProgress(p); };
  // Stable handle to refreshGit so the once-registered agent-event listener can
  // call the latest version without re-registering.
  const refreshGitRef = useRef<() => void>(() => {});

  function StatusIndicator({ text }: { text: string | null }) {
    const verbs = ['Thinking', 'Pondering', 'Simmering', 'Cogitating', 'Synthesizing'];
    const [verb, setVerb] = useState(verbs[0]);
    const [frame, setFrame] = useState(0);
    const [seconds, setSeconds] = useState(0);

    useEffect(() => {
      setVerb(verbs[Math.floor(Math.random() * verbs.length)]);
      const vTimer = setInterval(() => {
        setVerb(verbs[Math.floor(Math.random() * verbs.length)]);
      }, 3000);
      const sTimer = setInterval(() => {
        setFrame((f) => (f + 1) % 10);
      }, 100);
      const tTimer = setInterval(() => {
        setSeconds((s) => s + 1);
      }, 1000);
      return () => { clearInterval(vTimer); clearInterval(sTimer); clearInterval(tTimer); };
    }, []);

    const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][frame];
    const label = text ?? `${verb}…`;

    return (
      <div className="status-indicator">
        <span className="status-spinner">{spinner}</span>
        <span className="status-label">{label}</span>
        <span className="status-esc">({seconds}s · esc to interrupt)</span>
      </div>
    );
  }

  /* ---- Skills state ---- */
  const [discoveredSkills, setDiscoveredSkills] = useState<any[]>([]);
  const [invokedSkills, setInvokedSkills] = useState<string[]>([]);

  /* ---- MCP state ---- */
  const [permissionQueue, setPermissionQueue] = useState<any[]>([]);
  const [questionQueue, setQuestionQueue] = useState<any[]>([]);
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
  };

  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => { setLinkWorkspace(workspace); }, [workspace]);

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
    const unsubscribe = window.electron.onAgentEvent((event: any) => {
      if (event.type === 'done') {
        setIsTyping(false);
        setStatusText(null);
        setPermissionQueue([]);
        setQuestionQueue([]);
        refreshGitRef.current?.();
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
              progress: progressRef.current,
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
                // Sidebar list only reflects persisted sessions — refresh it now
                // so a new/updated conversation shows up without a reload or
                // "New Chat" click. Safe even if a newer session was already
                // adopted (epoch mismatch above): the list still needs the
                // just-written row either way.
                window.electron?.listSessions?.().then((list: any) => setSessionList(list ?? []));
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
      if (event.type === 'question') {
        setQuestionQueue(prev => [...prev, event]);
        return;
      }
      if (event.type === 'status') {
        setStatusText(event.content);
        return;
      }
      if (event.type === 'progress') {
        setProgressBoth({ goal: event.goal, steps: event.steps });
        return;
      }
      if (event.type === 'skill_installed') {
        // Listener is registered once ([] effect) so `workspace` is stale here;
        // read the live value from the ref kept in sync by its own effect.
        const ws = sessionSnapshotRef.current?.workspace;
        if (ws) window.electron?.discoverSkills?.(ws).then((list: any) => setDiscoveredSkills(list ?? []));
        if (event.id) setInvokedSkills((prev) => (prev.includes(event.id) ? prev : [...prev, event.id]));
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
            newMsgs.push({ id: nextMsgId(), role: 'assistant', content: event.content, ts: Date.now() });
          }
        } else if (event.type === 'tool_call') {
          if (event.name === 'skill') {
            try {
              const { skill_id } = JSON.parse(event.arguments ?? '{}');
              if (typeof skill_id === 'string' && skill_id) {
                setInvokedSkills((prev) => (prev.includes(skill_id) ? prev : [...prev, skill_id]));
              }
            } catch (e) {
              console.warn('[moon] skill tool arguments unparseable', e); // skip badge update
            }
          }
          // Keep messages in generation order: once an assistant message has
          // text, later tool calls start a NEW message so text → widget → text
          // renders chronologically (each message is [tools block][text]).
          if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content === '') {
            newMsgs[lastIdx] = { ...lastMsg, toolCalls: [...(lastMsg.toolCalls || []), event] };
          } else {
            newMsgs.push({ id: nextMsgId(), role: 'assistant', content: '', toolCalls: [event], ts: Date.now() });
          }
        } else if (event.type === 'tool_result') {
          if (lastMsg && lastMsg.toolCalls) {
            const callIdx = lastMsg.toolCalls.findIndex((c: any) =>
              c.name === event.name && (c.agent ?? 'main') === (event.agent ?? 'main') && !c.result);
            if (callIdx !== -1) {
              const toolCalls = [...lastMsg.toolCalls];
              toolCalls[callIdx] = { ...toolCalls[callIdx], result: event.result, ...(event.fileChange ? { fileChange: event.fileChange } : {}) };
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
          newMsgs.push({ id: nextMsgId(), role: 'assistant', content: `Error: ${event.content}`, ts: Date.now() });
        }
        return newMsgs;
      });
    });
    return unsubscribe;
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

  const refreshGit = () => {
    const ws = sessionSnapshotRef.current?.workspace ?? workspace;
    if (!ws) { setGitSnapshot(null); return; }
    setGitLoading(true);
    window.electron?.gitSnapshot?.(ws)
      .then((snap: any) => setGitSnapshot(snap ?? null))
      .catch(() => setGitSnapshot(null))
      .finally(() => setGitLoading(false));
  };
  refreshGitRef.current = refreshGit;

  const handleCommit = async (message: string) => {
    if (!workspace) return { ok: false, error: 'No workspace.' };
    const res = await window.electron?.gitCommit?.(workspace, message);
    refreshGit();
    return res ?? { ok: false, error: 'Commit failed.' };
  };

  const handleGenerateCommitMessage = async () => {
    if (!workspace) return { ok: false, error: 'No workspace.' };
    const res = await window.electron?.gitGenerateCommitMessage?.(workspace, config?.activeProfileId);
    return res ?? { ok: false, error: 'Generation failed.' };
  };

  const handleCheckout = async (branch: string) => {
    if (!workspace) return;
    const res = await window.electron?.gitCheckout?.(workspace, branch);
    if (!res?.ok) appendLocalNote(`Branch switch failed: ${res?.error ?? 'unknown error'}`);
    refreshGit();
  };

  useEffect(() => {
    refreshDiscoveredSkills();
    refreshGit();
  }, [workspace]);

  // First open of a workspace: bootstrap .moon (memory index, skills dir) and
  // seed MOON.md with @imports of any agent configs found (CLAUDE.md, ...).
  useEffect(() => {
    if (!workspace) return;
    window.electron?.initWorkspace?.(workspace).then((res: any) => {
      if (!res?.created) return;
      const imported = res.sources?.length
        ? ` — imported ${res.sources.length} agent config${res.sources.length === 1 ? '' : 's'} (${res.sources.join(', ')})`
        : '';
      appendLocalNote(`Initialized .moon workspace${imported}`);
    });
  }, [workspace]);

  // Refresh backing data when a modal opens; keep the sidebar task list fresh.
  useEffect(() => {
    if (activeModal === 'skills') refreshDiscoveredSkills();
    if (activeModal === 'mcp') window.electron?.mcpList?.().then((d: any) => d && setMcpData(d));
  }, [activeModal]);

  // When the right panel is opened, pull a fresh git snapshot.
  useEffect(() => {
    if (rightPanelOpen) refreshGit();
  }, [rightPanelOpen]);

  const startNewChat = () => {
    sessionEpochRef.current += 1;
    setMessages([]);
    setHistory(undefined);
    setCurrentSessionId(null);
    setSessionUsageBoth(EMPTY_SESSION_USAGE);
    setContextInfoBoth(null);
    setProgressBoth(null);
    setCurrentCreatedAt(Date.now());
    window.electron?.listSessions?.().then((list: any) => setSessionList(list ?? []));
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

  const quickAddMemory = async (raw: string) => {
    const text = raw.replace(/^#+\s*/, '').trim();
    if (!text) { appendLocalNote('Nothing to remember — type `# your note`.'); return; }
    const global = window.confirm('Save to GLOBAL memory (all projects)?\n\nOK = global (~/.moon/MOON.md)\nCancel = this project (MOON.md)');
    const scope = global ? 'global' : 'project';
    if (scope === 'project' && !workspace) { appendLocalNote('Open a workspace to save project memory.'); return; }
    const res = await window.electron?.appendMemory(scope, text, workspace);
    if (res?.ok) appendLocalNote(`Remembered (${scope}): ${text}`);
    else appendLocalNote(`Couldn't save memory${res?.error ? `: ${res.error}` : '.'}`);
  };

  const handleSend = () => {
    const trimmed = input.trim();
    if (trimmed.startsWith('#')) { setInput(''); quickAddMemory(trimmed); return; }
    if (!input.trim() || !workspace || !activeProfile?.hasKey) return;

    const newMsg: ChatMessage = { id: nextMsgId(), role: 'user', content: input, ts: Date.now() };
    setMessages(prev => [...prev, newMsg]);
    setInput('');
    setIsTyping(true);
    setStatusText(null);

    window.electron?.sendPrompt(input, workspace, config.activeProfileId, history, {
      // Real usage only — an estimate as the compaction trigger could compact
      // too early (or too late) when the provider never reports usage.
      lastInputTokens: contextInfo && !contextInfo.estimated ? contextInfo.lastInputTokens : undefined,
      sessionId: currentSessionId ?? undefined,
    });
  };

  /* Retry a user message: strip everything from that message onward, then
     re-send its content with the history that preceded it. */
  const handleRetry = (index: number) => {
    if (isTyping || !workspace || !activeProfile?.hasKey) return;
    const msg = messages[index];
    if (!msg || msg.role !== 'user') return;
    setMessages(prev => [...prev.slice(0, index), { ...msg, id: nextMsgId(), ts: Date.now() }]);
    setIsTyping(true);
    setStatusText(null);
    window.electron?.sendPrompt(msg.content, workspace, config.activeProfileId, history, {
      lastInputTokens: contextInfo && !contextInfo.estimated ? contextInfo.lastInputTokens : undefined,
      sessionId: currentSessionId ?? undefined,
    });
  };

  /* ---- Skills handlers ---- */
  const handleSendWithSkillContent = (userPrompt: string, skillContent: string) => {
    if (!workspace || !activeProfile?.hasKey) return;
    const newMsg: ChatMessage = { id: nextMsgId(), role: 'user', content: userPrompt, ts: Date.now() };
    setMessages(prev => [...prev, newMsg]);
    setInput('');
    setIsTyping(true);
    setStatusText(null);
    window.electron?.sendPrompt(userPrompt, workspace, config.activeProfileId, history, {
      lastInputTokens: contextInfo && !contextInfo.estimated ? contextInfo.lastInputTokens : undefined,
      skillContent,
      sessionId: currentSessionId ?? undefined,
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
      setActiveModal('skills');
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
      setActiveModal('skills');
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
      setActiveModal('skills');
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
      setActiveModal('skills');
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
    setActiveModal(null);
    // Restore persisted usage; absent → null/zeros, and the display layer
    // falls back to a live chars/4 estimate of the restored history.
    setSessionUsageBoth(s.usage?.session ?? EMPTY_SESSION_USAGE);
    setContextInfoBoth(s.usage?.context ?? null);
    setProgressBoth(s.progress ?? null);
    setCurrentCreatedAt(s.createdAt ?? Date.now());
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
    setMessages((prev) => [...prev, { id: nextMsgId(), role: 'assistant', content, ts: Date.now() }]);
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
    {
      name: 'memory', description: 'Open a memory instruction file in your editor', run: () => {
        const global = window.confirm('Open GLOBAL memory?\n\nOK = global (~/.moon/MOON.md)\nCancel = this project (MOON.md)');
        window.electron?.openMemory(global ? 'global' : 'project', workspace).then((res: any) => {
          if (!res?.ok) appendLocalNote(`Couldn't open memory${res?.error ? `: ${res.error}` : '.'}`);
        });
      }
    },
    { name: 'remember', description: 'Save a memory: /remember <text>', run: (arg?: string) => quickAddMemory(arg ?? '') },
    { name: 'skills', description: 'Open the skills panel', run: () => setActiveModal('skills') },
    { name: 'sessions', description: 'Saved tasks are in the left sidebar', run: () => appendLocalNote('Saved tasks are listed in the left sidebar, grouped by workspace.') },
    { name: 'mcp', description: 'Open MCP servers', run: () => setActiveModal('mcp') },
    { name: 'settings', description: 'Open settings', run: () => setActiveModal('settings') },
    {
      name: 'debug', description: 'Show diagnostic info about skills, workspace, and config', run: () => {
        const lines = [
          `workspace: ${workspace ?? '(none)'}`,
          `activeProfile: ${activeProfile?.name ?? '(none)'}`,
          `discoveredSkills: ${discoveredSkills.map((s: any) => s.id).join(', ') || '(none)'}`,
          `invokedSkills: ${invokedSkills.join(', ') || '(none)'}`,
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
        setActiveModal('skills');
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

  const respondQuestion = (answer: string | null) => {
    const req = questionQueue[0];
    if (!req) return;
    window.electron?.respondQuestion(req.id, answer);
    setQuestionQueue(prev => prev.slice(1));
  };

  const inputDisabled = !workspace || isTyping || !activeProfile?.hasKey;
  const inputPlaceholder = !workspace
    ? 'Select a workspace to get started...'
    : !activeProfile?.hasKey
      ? 'Add a model profile in Settings…'
      : 'Ask Moon Code anything. Shift+Enter for new line.';

  const firstUser = messages.find((m) => m.role === 'user');
  const taskTitle = firstUser ? firstUser.content.trim().slice(0, 90) : '';

  // A turn's file-change summary is attached to the last assistant message of a
  // contiguous assistant run (text→tool→text splits into several messages).
  const turnToolCalls = (endIdx: number) => {
    let start = endIdx;
    while (start - 1 >= 0 && messages[start - 1].role === 'assistant') start--;
    const calls: any[] = [];
    for (let k = start; k <= endIdx; k++) if (messages[k].toolCalls) calls.push(...messages[k].toolCalls);
    return calls;
  };
  const isTurnEnd = (i: number) =>
    messages[i].role === 'assistant' && (i === messages.length - 1 || messages[i + 1].role === 'user');

  return (
    <div className="app-shell">
      <TaskSidebar
        sessions={sessionList}
        currentSessionId={currentSessionId}
        workspace={workspace}
        onNewTask={startNewChat}
        onOpenWorkspace={selectWorkspace}
        onOpenSkills={() => setActiveModal('skills')}
        onOpenSettings={() => setActiveModal('settings')}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
        activeProfileName={activeProfile?.name}
      />

      <div className="center-col">
        <TopBar
          title={taskTitle}
          workspace={workspace}
          git={gitSnapshot}
          onCheckout={handleCheckout}
          rightPanelOpen={rightPanelOpen}
          onToggleRightPanel={toggleRightPanel}
        />

        <div className="chat-container">
          {messages.length === 0 ? (
            <div className="chat-empty">
              <h2>How can I help you code today?</h2>
              <p>{workspace ? 'Ask anything, or start a task below.' : 'Open a workspace to get started.'}</p>
            </div>
          ) : (
            messages.map((msg, i) => (
              // Sessions saved before messages carried ids fall back to index.
              <div key={msg.id ?? i} className="msg-row">
                {msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0 && (
                  <div className="activity-block">
                    {msg.toolCalls.map((tool: any, j: number) => tool.name === 'render_ui'
                      ? <UiWidgetBlock key={j} tool={tool} />
                      : <ToolChip key={j} tool={tool} />)}
                  </div>
                )}
                {(msg.role === 'user' || msg.content !== '' || (isTyping && i === messages.length - 1)) && (
                  <div className={`msg ${msg.role === 'user' ? 'msg-user' : 'msg-assistant'}`}>
                    {msg.role === 'assistant' ? (
                      <AssistantContent content={msg.content} streaming={isTyping && i === messages.length - 1} />
                    ) : msg.content}
                  </div>
                )}
                {msg.content !== '' && !(isTyping && i === messages.length - 1) && (
                  <MessageActions
                    content={msg.content}
                    ts={msg.ts}
                    onRetry={msg.role === 'user' && !isTyping ? () => handleRetry(i) : undefined}
                  />
                )}
                {isTurnEnd(i) && !(isTyping && i === messages.length - 1) && (
                  <TurnSummaryCard toolCalls={turnToolCalls(i)} />
                )}
              </div>
            ))
          )}
          {permissionQueue.length > 0 && (
            <PermissionRequest req={permissionQueue[0]} onRespond={respondPermission} />
          )}
          {permissionQueue.length === 0 && questionQueue.length > 0 && (
            <QuestionPrompt req={questionQueue[0]} onAnswer={respondQuestion} />
          )}
          {isTyping && permissionQueue.length === 0 && questionQueue.length === 0 && <StatusIndicator text={statusText} />}
          <div ref={chatEndRef} />
        </div>

        {displayContext && displayContext.pct >= 0.8 && !isTyping && (
          <div className="context-warning-banner">
            <span>
              Context is {Math.round(displayContext.pct * 100)}%{displayContext.estimated ? ' (estimated)' : ''} full — compaction will run automatically soon.
            </span>
            <button className="context-warning-action" onClick={() => compactNow()}>Compact now</button>
          </div>
        )}

        <div className="input-dock">
          <RichInput
            value={input}
            onChange={setInput}
            onSend={handleSend}
            disabled={inputDisabled}
            placeholder={inputPlaceholder}
            onAddSkill={() => setActiveModal('skills')}
            mcpServers={connectedMcpServers}
            onConnectMcp={() => setActiveModal('mcp')}
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

      {rightPanelOpen && (
        <RightPanel
          git={gitSnapshot}
          loading={gitLoading}
          workspace={workspace}
          onRefresh={refreshGit}
          onCommit={handleCommit}
          onGenerateMessage={handleGenerateCommitMessage}
          progress={progress}
          sessionUsage={sessionUsage}
          createdAt={currentCreatedAt}
        />
      )}

      <OverlayModal open={activeModal === 'skills'} onClose={() => setActiveModal(null)} wide>
        <React.Suspense fallback={null}>
          <SkillsPanel
            discoveredSkills={discoveredSkills}
            invokedSkillIds={invokedSkills}
            onInvokeSkill={(id: string) => { invokeSkillById(id); setActiveModal(null); }}
            onCreateSkill={handleCreateSkill}
            onInstallSkill={handleInstallSkill}
            onInstallMarketplaceSkill={handleInstallMarketplaceSkill}
            onInstallSkillFromUrl={handleInstallSkillFromUrl}
            skillInstallKey={skillInstallKey}
          />
        </React.Suspense>
      </OverlayModal>

      <OverlayModal open={activeModal === 'mcp'} onClose={() => setActiveModal(null)} wide>
        <React.Suspense fallback={null}>
          <McpPanel
            servers={mcpData.servers}
            statuses={mcpData.statuses}
            busy={isTyping}
            onConnect={(id: string) => window.electron?.connectMcp(id).then(setMcpData)}
            onDisconnect={(id: string) => window.electron?.disconnectMcp(id).then(setMcpData)}
            onSaveServer={(def: any, secrets: any) => window.electron?.upsertMcpServer(def, secrets).then(setMcpData)}
            onDelete={(id: string) => window.electron?.deleteMcpServer(id).then(setMcpData)}
            onAddPreset={handleAddMcpPreset}
          />
        </React.Suspense>
      </OverlayModal>

      <OverlayModal open={activeModal === 'settings'} onClose={() => setActiveModal(null)}>
        <React.Suspense fallback={null}>
          <SettingsPanel
            config={config}
            onSetActiveProfile={(id: string) => window.electron?.setActiveProfile(id).then(setConfig)}
            onSaveProfile={(profile: any, apiKey?: string) => window.electron?.upsertProfile(profile, apiKey).then(setConfig)}
            onDeleteProfile={(id: string) => window.electron?.deleteProfile(id).then(setConfig)}
          />
        </React.Suspense>
      </OverlayModal>

      <OverlayModal open={activeModal === 'usage'} onClose={() => setActiveModal(null)}>
        <React.Suspense fallback={null}>
          <UsagePanel
            sessionUsage={sessionUsage}
            contextInfo={displayContext}
            activeProfile={activeProfile}
            activeLimits={activeLimits}
          />
        </React.Suspense>
      </OverlayModal>
    </div>
  );
}
