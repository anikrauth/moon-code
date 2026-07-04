// @ts-nocheck
import React, { useEffect } from 'react';
import { X } from 'lucide-react';

export default function OverlayModal({ open, onClose, children, wide }: any) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="overlay-backdrop" onMouseDown={onClose}>
      <div
        className={`overlay-modal ${wide ? 'overlay-wide' : ''}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button className="overlay-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
        <div className="overlay-body">{children}</div>
      </div>
    </div>
  );
}
