// @ts-nocheck
/* Legacy path: pre-render_ui sessions persisted assistant answers as raw
   SpecStream JSONL message content. Kept so old sessions still render as UI. */
import { parseRenderUiSpec } from '@shared/lib/renderUiSpec';

export function parseAssistantContent(content) {
    const parsed = parseRenderUiSpec(content);
    return parsed.ok ? parsed.spec : null;
}
