// @ts-nocheck
import React, { useState, useEffect } from 'react';

/* Tool name -> human header ("Run command", "Edit file <path>", ...). Falls
   back to the raw tool name for anything not in the map. */
function header(req: any): { label: string; target?: string } {
  const a = req.arguments ?? {};
  switch (req.name) {
    case 'run_command': return { label: 'Run command' };
    case 'edit_file': return { label: 'Edit file', target: a.filePath };
    case 'write_file': return { label: 'Write file', target: a.filePath };
    case 'read_file': return { label: 'Read file', target: a.filePath };
    default: return { label: req.name };
  }
}

/* Split an edit into removed/added lines for a colored diff. */
function DiffPreview({ oldString, newString }: { oldString?: string; newString?: string }) {
  const del = (oldString ?? '').split('\n');
  const add = (newString ?? '').split('\n');
  return (
    <div className="perm-diff">
      {del.map((l: string, i: number) => (
        <div key={`d${i}`} className="perm-diff-line perm-diff-del"><span className="perm-diff-gutter">-</span>{l}</div>
      ))}
      {add.map((l: string, i: number) => (
        <div key={`a${i}`} className="perm-diff-line perm-diff-add"><span className="perm-diff-gutter">+</span>{l}</div>
      ))}
    </div>
  );
}

function Body({ req }: { req: any }) {
  const a = req.arguments ?? {};
  if (req.name === 'edit_file') {
    return <DiffPreview oldString={a.oldString} newString={a.newString} />;
  }
  const text = req.name === 'run_command'
    ? (a.command ?? '')
    : (a.filePath ?? JSON.stringify(a, null, 2));
  return <pre className="perm-code">{text}</pre>;
}

export default function PermissionRequest({ req, onRespond }: { req: any; onRespond: (allow: boolean, alwaysAllow: boolean) => void }) {
  const options = [
    { label: 'Yes', act: () => onRespond(true, false) },
    { label: `Yes, and don't ask again for ${req.name}`, act: () => onRespond(true, true) },
    { label: 'No, and tell the agent what to do (esc)', act: () => onRespond(false, false) },
  ];
  const [active, setActive] = useState(0);

  // Re-key on req.id so a fresh request resets the highlighted option.
  useEffect(() => { setActive(0); }, [req.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '1' || e.key === '2' || e.key === '3') {
        e.preventDefault(); e.stopPropagation();
        options[Number(e.key) - 1].act();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation();
        setActive((i) => (i + 1) % options.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        setActive((i) => (i - 1 + options.length) % options.length);
      } else if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        options[active].act();
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        onRespond(false, false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, req.id]);

  const { label, target } = header(req);
  const isSubagent = req.agent && req.agent !== 'main';

  return (
    <div className="permission-card">
      <div className="perm-header">
        {isSubagent && <span className="agent-badge">{req.agent}</span>}
        <span className="perm-header-label">{label}</span>
        {target && <span className="perm-header-target">{target}</span>}
      </div>
      <Body req={req} />
      <div className="perm-question">Do you want to proceed?</div>
      <div className="perm-options">
        {options.map((o, i) => (
          <button
            key={i}
            className={`perm-option ${i === active ? 'perm-option-active' : ''}`}
            onClick={o.act}
            onMouseEnter={() => setActive(i)}
          >
            <span className="perm-option-marker">{i === active ? '❯' : ' '}</span>
            <span className="perm-option-num">{i + 1}.</span>
            <span className="perm-option-label">{o.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
