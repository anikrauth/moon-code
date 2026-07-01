// @ts-nocheck
import { compileSpecStream, validateSpec, autoFixSpec, isNonEmptySpec } from '@json-render/core';

export function parseAssistantContent(content) {
    try {
        const rawSpec = compileSpecStream(content);
        if (!isNonEmptySpec(rawSpec)) {
            return null;
        }
        const { spec: fixedSpec } = autoFixSpec(rawSpec);
        const result = validateSpec(fixedSpec);
        if (!result.valid) {
            return null;
        }
        return fixedSpec;
    } catch {
        return null;
    }
}
