// @ts-nocheck
import { compileSpecStream, autoFixSpec, isNonEmptySpec, validateSpec, formatSpecIssues } from '@json-render/core';
import { catalog } from '../config/uiCatalog';

export type ParseResult = { ok: true; spec: any } | { ok: false; error: string };

/* Single validation path shared by the main-process render_ui tool (so the
   model gets a retryable error for bad specs) and the renderer widget (so a
   spec that passed the tool never renders differently than it validated). */
export function parseRenderUiSpec(jsonl: string): ParseResult {
    try {
        const raw = compileSpecStream(jsonl);
        if (!isNonEmptySpec(raw)) {
            return { ok: false, error: 'spec compiled to an empty UI (no /root or /elements ops)' };
        }
        const { spec } = autoFixSpec(raw);
        // The react schema requires `visible` on every element; the model never
        // sends it (our components are always visible), so default it here.
        for (const el of Object.values(spec.elements ?? {})) {
            if (el && typeof el === 'object' && el.visible === undefined) el.visible = true;
        }
        const structural = validateSpec(spec);
        if (!structural.valid) {
            return { ok: false, error: formatSpecIssues(structural.issues) };
        }
        // Catalog-aware pass: rejects unknown component types and bad props.
        const result = catalog.validate(spec);
        if (!result.success) {
            const detail = result.error?.issues
                ?.map((i) => `${i.path.join('.')}: ${i.message}`)
                .join('; ') ?? 'spec does not match the component catalog';
            return { ok: false, error: detail };
        }
        return { ok: true, spec };
    } catch (e: any) {
        return { ok: false, error: `could not parse spec JSONL: ${e?.message ?? String(e)}` };
    }
}
