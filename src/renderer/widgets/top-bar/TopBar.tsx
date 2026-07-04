// @ts-nocheck
import React, { useState, useRef, useEffect } from 'react';
import { FolderOpen, GitBranch, PanelRight, Check, ChevronDown } from 'lucide-react';

function wsName(p?: string): string {
  if (!p) return '';
  return p.split('/').filter(Boolean).pop() || p;
}

export default function TopBar({
  title,
  workspace,
  git,
  onCheckout,
  rightPanelOpen,
  onToggleRightPanel,
}: any) {
  const [branchOpen, setBranchOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!branchOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setBranchOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [branchOpen]);

  const isRepo = git?.gitAvailable && git?.isRepo;
  const branch = isRepo ? git.branch : null;
  const branches = isRepo ? (git.branches ?? []) : [];

  return (
    <header className="top-bar">
      <div className="tb-title" title={title || undefined}>
        {title || 'New Task'}
      </div>

      <div className="tb-right">
        {workspace && (
          <div className="tb-chip" title={workspace}>
            <FolderOpen size={13} />
            <span>{wsName(workspace)}</span>
          </div>
        )}

        {branch && (
          <div className="tb-branch" ref={ref}>
            <button className="tb-chip tb-chip-btn" onClick={() => setBranchOpen((o) => !o)} title="Switch branch">
              <GitBranch size={13} />
              <span>{branch}</span>
              <ChevronDown size={12} className="tb-chip-caret" />
            </button>
            {branchOpen && (
              <div className="tb-branch-menu">
                {branches.length === 0 && <div className="tb-branch-empty">No branches</div>}
                {branches.map((b: string) => (
                  <button
                    key={b}
                    className={`tb-branch-item ${b === branch ? 'current' : ''}`}
                    onClick={() => { setBranchOpen(false); if (b !== branch) onCheckout(b); }}
                  >
                    <Check size={13} className="tb-branch-check" style={{ opacity: b === branch ? 1 : 0 }} />
                    <span>{b}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <button
          className={`tb-icon-btn ${rightPanelOpen ? 'active' : ''}`}
          onClick={onToggleRightPanel}
          title={rightPanelOpen ? 'Hide panel' : 'Show panel'}
          aria-label="Toggle side panel"
        >
          <PanelRight size={16} />
        </button>
      </div>
    </header>
  );
}
