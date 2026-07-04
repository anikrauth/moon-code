// @ts-nocheck
import React, { useState, useEffect } from 'react';

/* Modeled on PermissionRequest: same card/keyboard-nav shape, but for the
   agent's ask_user tool — labeled options instead of an allow/deny choice,
   and no "always allow" concept (each question is one-off). */
export default function QuestionPrompt({ req, onAnswer }: { req: any; onAnswer: (label: string | null) => void }) {
  const options = req.options ?? [];
  const [active, setActive] = useState(0);

  // Re-key on req.id so a fresh question resets the highlighted option.
  useEffect(() => { setActive(0); }, [req.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (n >= 1 && n <= options.length) {
        e.preventDefault(); e.stopPropagation();
        onAnswer(options[n - 1].label);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation();
        setActive((i) => (i + 1) % options.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        setActive((i) => (i - 1 + options.length) % options.length);
      } else if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        onAnswer(options[active]?.label ?? null);
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        onAnswer(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, req.id, options]);

  const isSubagent = req.agent && req.agent !== 'main';

  return (
    <div className="permission-card question-card">
      <div className="perm-header">
        {isSubagent && <span className="agent-badge">{req.agent}</span>}
        <span className="perm-header-label">Question</span>
      </div>
      <div className="perm-question">{req.question}</div>
      <div className="perm-options">
        {options.map((o: any, i: number) => (
          <button
            key={i}
            className={`perm-option ${i === active ? 'perm-option-active' : ''}`}
            onClick={() => onAnswer(o.label)}
            onMouseEnter={() => setActive(i)}
          >
            <span className="perm-option-marker">{i === active ? '❯' : ' '}</span>
            <span className="perm-option-num">{i + 1}.</span>
            <span className="perm-option-body">
              <span className="perm-option-label">{o.label}</span>
              {o.description && <span className="perm-option-desc">{o.description}</span>}
            </span>
          </button>
        ))}
      </div>
      <div className="question-skip">
        <button className="question-skip-btn" onClick={() => onAnswer(null)}>Skip (esc)</button>
      </div>
    </div>
  );
}
