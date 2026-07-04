// @ts-nocheck
import React, { useMemo } from 'react';
import { Plus, FolderOpen, Puzzle, ListFilter, Settings, Trash2 } from 'lucide-react';

function shortTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / 604800)}w`;
}

function wsName(p?: string): string {
  if (!p) return 'No workspace';
  return p.split('/').filter(Boolean).pop() || p;
}

export default function TaskSidebar({
  sessions,
  currentSessionId,
  workspace,
  onNewTask,
  onOpenWorkspace,
  onOpenSkills,
  onOpenSettings,
  onSelectSession,
  onDeleteSession,
  activeProfileName,
}: any) {
  // Group sessions by workspace folder name, preserving recency order
  // (sessions arrive newest-first from the index).
  const groups = useMemo(() => {
    const byWs = new Map<string, any[]>();
    for (const s of sessions ?? []) {
      const key = s.workspace ?? '';
      if (!byWs.has(key)) byWs.set(key, []);
      byWs.get(key)!.push(s);
    }
    return [...byWs.entries()].map(([ws, list]) => ({ ws, name: wsName(ws), list }));
  }, [sessions]);

  return (
    <aside className="task-sidebar">
      <div className="ts-top">
        <div className="ts-traffic-clearance" />
        <nav className="ts-nav">
          <button className="ts-nav-item" onClick={onNewTask}>
            <Plus size={16} />
            <span>New Task</span>
            <kbd className="ts-kbd">⌘N</kbd>
          </button>
          <button className="ts-nav-item" onClick={onOpenWorkspace}>
            <FolderOpen size={16} />
            <span>Open Workspace</span>
          </button>
          <button className="ts-nav-item" onClick={onOpenSkills}>
            <Puzzle size={16} />
            <span>Skills</span>
          </button>
        </nav>
      </div>

      <div className="ts-tasks">
        <div className="ts-section-head">
          <span>Tasks</span>
          <ListFilter size={14} className="ts-filter-icon" />
        </div>

        <div className="ts-list">
          {groups.length === 0 && (
            <div className="ts-empty">
              No tasks yet.<br />Start one with New Task.
            </div>
          )}
          {groups.map((g, gi) => (
            <div className="ts-group" key={g.ws || gi}>
              <div className="ts-group-label">{g.name}</div>
              {g.list.map((s: any, i: number) => (
                <div
                  key={s.id}
                  className={`ts-task-row ${s.id === currentSessionId ? 'active' : ''}`}
                  style={{ '--i': i } as any}
                  onClick={() => onSelectSession(s.id)}
                  title={s.title || 'Untitled task'}
                >
                  <span className="ts-task-dot" />
                  <span className="ts-task-title">{s.title || 'Untitled task'}</span>
                  <span className="ts-task-time">{shortTime(s.updatedAt)}</span>
                  <button
                    className="ts-task-del"
                    aria-label="Delete task"
                    onClick={(e) => { e.stopPropagation(); onDeleteSession(s.id); }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="ts-footer">
        <div className="ts-avatar">{(activeProfileName?.[0] ?? 'M').toUpperCase()}</div>
        <span className="ts-user-name">{activeProfileName ?? 'Moon Code'}</span>
        <button className="ts-gear" aria-label="Settings" onClick={onOpenSettings}>
          <Settings size={16} />
        </button>
      </div>
    </aside>
  );
}
