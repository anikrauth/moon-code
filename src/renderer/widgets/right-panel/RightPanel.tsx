// @ts-nocheck
import React, { useState } from 'react';
import { GitCommit, RefreshCw, Target, ListChecks, Check, FileText } from 'lucide-react';

function fmtTokens(n: number): string {
  if (!n) return '0';
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtElapsed(ms: number): string {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function GitSection({ git, loading, workspace, onRefresh, onCommit }: any) {
  const [msg, setMsg] = useState('');
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doCommit = async () => {
    if (!msg.trim() || committing) return;
    setCommitting(true);
    setError(null);
    const res = await onCommit(msg.trim());
    setCommitting(false);
    if (res?.ok) { setMsg(''); }
    else setError(res?.error ?? 'Commit failed.');
  };

  let body: React.ReactNode;
  if (!workspace) {
    body = <div className="rp-empty">Open a workspace to see changes.</div>;
  } else if (loading && !git) {
    body = (
      <div className="rp-skeleton-group">
        <div className="rp-skeleton" style={{ width: '70%' }} />
        <div className="rp-skeleton" style={{ width: '55%' }} />
        <div className="rp-skeleton" style={{ width: '80%' }} />
      </div>
    );
  } else if (!git?.gitAvailable) {
    body = <div className="rp-empty">Git is not installed.</div>;
  } else if (!git.isRepo) {
    body = <div className="rp-empty">Not a git repository.</div>;
  } else {
    const files = git.files ?? [];
    body = (
      <>
        <div className="rp-changes-head">
          <span className="rp-changes-label">Changes</span>
          <span className="rp-changes-totals">
            {files.length === 0 ? (
              <span className="rp-muted">clean</span>
            ) : (
              <>
                <span className="diff-add">+{git.totals.adds}</span>
                <span className="diff-del">−{git.totals.dels}</span>
              </>
            )}
          </span>
        </div>
        {files.length > 0 && (
          <div className="rp-file-list">
            {files.slice(0, 40).map((f: any, i: number) => (
              <div className="rp-file-row" key={f.path} style={{ '--i': i } as any} title={f.path}>
                <FileText size={12} className="rp-file-icon" />
                <span className="rp-file-path">{f.path}</span>
                {f.binary ? (
                  <span className="rp-muted">bin</span>
                ) : (
                  <span className="rp-file-stat">
                    {f.adds > 0 && <span className="diff-add">+{f.adds}</span>}
                    {f.dels > 0 && <span className="diff-del">−{f.dels}</span>}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div className="rp-commit">
            <input
              className="rp-commit-input"
              placeholder="Commit message…"
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') doCommit(); }}
            />
            <button className="rp-commit-btn" disabled={!msg.trim() || committing} onClick={doCommit}>
              <GitCommit size={13} />
              {committing ? 'Committing…' : 'Commit'}
            </button>
          </div>
        )}
        {error && <div className="rp-error">{error}</div>}
      </>
    );
  }

  return (
    <section className="rp-section">
      <div className="rp-section-head">
        <span className="rp-section-title">Git tools</span>
        {workspace && (
          <button className="rp-refresh" onClick={onRefresh} title="Refresh" aria-label="Refresh git">
            <RefreshCw size={13} className={loading ? 'rp-spin' : ''} />
          </button>
        )}
      </div>
      {body}
    </section>
  );
}

function GoalSection({ progress, sessionUsage, createdAt }: any) {
  if (!progress?.goal) {
    return (
      <section className="rp-section">
        <div className="rp-section-head">
          <Target size={14} className="rp-section-icon" />
          <span className="rp-section-title">Goal</span>
        </div>
        <div className="rp-empty">No active goal.</div>
      </section>
    );
  }
  const steps = progress.steps ?? [];
  const done = steps.filter((s: any) => s.status === 'done').length;
  const complete = steps.length > 0 && done === steps.length;
  const tokens = (sessionUsage?.inputTokens ?? 0) + (sessionUsage?.outputTokens ?? 0);
  const elapsed = createdAt ? Date.now() - createdAt : 0;

  return (
    <section className="rp-section">
      <div className="rp-section-head">
        <Target size={14} className="rp-section-icon" />
        <span className="rp-section-title">Goal</span>
        <span className={`rp-goal-status ${complete ? 'complete' : ''}`}>
          {complete ? 'Complete' : 'In progress'}
        </span>
      </div>
      <div className="rp-goal-text">{progress.goal}</div>
      <div className="rp-goal-meta">
        <span>{done}/{steps.length} steps</span>
        <span className="rp-dot-sep">·</span>
        <span>{fmtElapsed(elapsed)}</span>
        <span className="rp-dot-sep">·</span>
        <span>{fmtTokens(tokens)} tokens</span>
      </div>
    </section>
  );
}

function ProgressSection({ progress }: any) {
  const steps = progress?.steps ?? [];
  if (steps.length === 0) {
    return (
      <section className="rp-section">
        <div className="rp-section-head">
          <ListChecks size={14} className="rp-section-icon" />
          <span className="rp-section-title">Progress</span>
        </div>
        <div className="rp-empty">Steps appear as the agent works.</div>
      </section>
    );
  }
  return (
    <section className="rp-section">
      <div className="rp-section-head">
        <ListChecks size={14} className="rp-section-icon" />
        <span className="rp-section-title">Progress</span>
      </div>
      <div className="rp-steps">
        {steps.map((s: any, i: number) => (
          <div className={`rp-step ${s.status}`} key={s.id ?? i} style={{ '--i': i } as any}>
            <span className="rp-step-marker">
              {s.status === 'done' ? <Check size={12} /> : <span className="rp-step-dot" />}
            </span>
            <span className="rp-step-text">{s.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function RightPanel(props: any) {
  return (
    <aside className="right-panel">
      <div className="rp-scroll">
        <GitSection {...props} />
        <GoalSection {...props} />
        <ProgressSection {...props} />
      </div>
    </aside>
  );
}
