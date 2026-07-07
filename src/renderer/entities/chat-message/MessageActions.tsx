import { useState } from 'react';

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

interface MessageActionsProps {
  content: string;
  ts?: number;
  /** Present only for the last user message → enables the retry button. */
  onRetry?: () => void;
}

/**
 * Copy / retry / timestamp row shown under a message bubble on hover.
 * Retry is only wired for user messages (re-sends the prompt); assistant
 * messages get copy + time only.
 */
export function MessageActions({ content, ts, onRetry }: MessageActionsProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.warn('[moon] copy to clipboard failed', e);
    }
  };

  return (
    <div className="msg-actions">
      <button
        type="button"
        className="msg-action-btn"
        onClick={handleCopy}
        title={copied ? 'Copied!' : 'Copy message'}
        aria-label="Copy message"
      >
        {copied ? '✓ Copied' : '⧉ Copy'}
      </button>
      {onRetry && (
        <button
          type="button"
          className="msg-action-btn"
          onClick={onRetry}
          title="Retry — resend this message"
          aria-label="Retry message"
        >
          ↻ Retry
        </button>
      )}
      {ts != null && <span className="msg-action-time">{formatTime(ts)}</span>}
    </div>
  );
}
