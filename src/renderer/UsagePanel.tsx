// @ts-nocheck
import React from 'react';
import { Gauge } from 'lucide-react';

const fmtTok = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : `${n}`);

export default function UsagePanel({ sessionUsage, contextInfo, activeProfile, activeLimits }) {
  const overridden = (field: string) => (activeProfile?.[field] ? ' (override)' : '');
  const pct = contextInfo ? Math.round(contextInfo.pct * 100) : 0;
  const p = activeLimits?.pricing;
  const cost = p && (sessionUsage.inputTokens || sessionUsage.outputTokens)
    ? ((sessionUsage.inputTokens - sessionUsage.cachedInputTokens) * p.inPerMTok
      + sessionUsage.cachedInputTokens * (p.cachedInPerMTok ?? p.inPerMTok)
      + sessionUsage.outputTokens * p.outPerMTok) / 1e6
    : null;

  return (
    <>
      <div className="sp-header">
        <div className="sp-header-title"><Gauge size={18} /><h3>Usage</h3></div>
      </div>
      <div className="usage-panel">
        <div className="usage-section">
          <span className="usage-section-label">Model</span>
          <div className="usage-row"><span>Name</span><span>{activeProfile?.model ?? '(none)'}</span></div>
          <div className="usage-row"><span>Context window</span><span>{activeLimits?.contextWindow?.toLocaleString() ?? '—'}{overridden('contextWindow')}</span></div>
          <div className="usage-row"><span>Max output</span><span>{activeLimits?.maxOutputTokens?.toLocaleString() ?? '—'}{overridden('maxOutputTokens')}</span></div>
          {activeLimits?.capabilities && (
            <div className="usage-row"><span>Capabilities</span><span>{[activeLimits.capabilities.tools && 'tools', activeLimits.capabilities.vision && 'vision'].filter(Boolean).join(', ') || 'none'}</span></div>
          )}
        </div>

        <div className="usage-section">
          <span className="usage-section-label">Context window</span>
          {contextInfo ? (
            <>
              <div className="usage-bar-track"><div className="usage-bar-fill" style={{ width: `${Math.min(100, pct)}%` }} /></div>
              <div className="usage-row">
                <span>{contextInfo.estimated ? '~' : ''}{fmtTok(contextInfo.lastInputTokens + contextInfo.lastOutputTokens)} / {fmtTok(contextInfo.contextWindow)} tokens</span>
                <span>{pct}%{contextInfo.estimated ? ' est.' : ''}</span>
              </div>
              {!contextInfo.estimated && (
                <div className="usage-row"><span>Last turn</span><span>{fmtTok(contextInfo.lastInputTokens)} in · {fmtTok(contextInfo.lastOutputTokens)} out</span></div>
              )}
            </>
          ) : (
            <div className="sp-empty">Empty — no conversation yet.</div>
          )}
        </div>

        <div className="usage-section">
          <span className="usage-section-label">Session</span>
          <div className="usage-row"><span>Turns</span><span>{sessionUsage.turns}</span></div>
          <div className="usage-row"><span>Input</span><span>{fmtTok(sessionUsage.inputTokens)}</span></div>
          <div className="usage-row"><span>Output</span><span>{fmtTok(sessionUsage.outputTokens)}</span></div>
          <div className="usage-row"><span>Cached</span><span>{fmtTok(sessionUsage.cachedInputTokens)}</span></div>
          {cost != null && <div className="usage-row"><span>Est. cost</span><span>${cost.toFixed(4)}</span></div>}
        </div>
      </div>
    </>
  );
}
