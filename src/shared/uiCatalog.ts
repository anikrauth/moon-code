// @ts-nocheck
import { defineCatalog } from '@json-render/core';
import { schema } from '@json-render/react/schema';
import { z } from 'zod';

export const catalog = defineCatalog(schema, {
    components: {
        Stack: {
            props: z.object({}),
            slots: ['default'],
            description: 'A vertical container for one or more blocks. Always the root element of every response.',
        },
        Text: {
            props: z.object({
                content: z.string(),
            }),
            slots: [],
            description: 'A paragraph of plain text.',
        },
        List: {
            props: z.object({
                items: z.array(z.string()),
                ordered: z.boolean().nullable(),
            }),
            slots: [],
            description: 'A bulleted (ordered: false/null) or numbered (ordered: true) list.',
        },
        Table: {
            props: z.object({
                headers: z.array(z.string()),
                rows: z.array(z.array(z.string())),
            }),
            slots: [],
            description: 'A table for tabular or file-listing data. Every row array must have the same length as headers.',
        },
        CodeBlock: {
            props: z.object({
                code: z.string(),
                language: z.string().nullable(),
            }),
            slots: [],
            description: 'A block of code, command output, or file contents. language is a lowercase name like "typescript" or "bash", or null if unknown.',
        },
    },
    actions: {},
});
