// @ts-nocheck
import { defineRegistry } from '@json-render/react';
import hljs from 'highlight.js';
import { catalog } from '../shared/uiCatalog';

function CodeBlock({ props }) {
    const highlighted = props.language && hljs.getLanguage(props.language)
        ? hljs.highlight(props.code, { language: props.language }).value
        : hljs.highlightAuto(props.code).value;
    return (
        <pre style={{ background: 'rgba(0,0,0,0.4)', padding: '12px', borderRadius: 'var(--radius-md)', overflowX: 'auto' }}>
            <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
        </pre>
    );
}

export const { registry } = defineRegistry(catalog, {
    components: {
        Stack: ({ children }) => (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>{children}</div>
        ),
        Text: ({ props }) => <p style={{ margin: 0 }}>{props.content}</p>,
        List: ({ props }) => {
            const Tag = props.ordered ? 'ol' : 'ul';
            return (
                <Tag style={{ margin: 0, paddingLeft: '20px' }}>
                    {props.items.map((item, i) => <li key={i}>{item}</li>)}
                </Tag>
            );
        },
        Table: ({ props }) => (
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead>
                    <tr>
                        {props.headers.map((h, i) => (
                            <th key={i} style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.2)', padding: '6px 10px' }}>{h}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {props.rows.map((row, i) => (
                        <tr key={i}>
                            {row.map((cell, j) => (
                                <td key={j} style={{ borderBottom: '1px solid rgba(255,255,255,0.1)', padding: '6px 10px' }}>{cell}</td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        ),
        CodeBlock,
    },
});
