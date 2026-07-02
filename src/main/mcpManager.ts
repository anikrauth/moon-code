// @ts-nocheck

export function createMcpManager({ getServer, resolveSecrets, onStatus }) {
    const connections = new Map(); // id -> { client, tools, serverName }
    const pending = new Map(); // id -> in-flight connect promise
    const statusMap = {};

    const emit = (id, status, extra = {}) => {
        statusMap[id] = { status, ...extra };
        try { onStatus({ id, status, ...extra }); } catch { /* renderer gone */ }
    };

    const slug = (s) => String(s).replace(/[^a-zA-Z0-9]+/g, '_');

    function connect(id) {
        if (pending.has(id)) return pending.get(id);
        const p = doConnect(id).finally(() => { pending.delete(id); });
        pending.set(id, p);
        return p;
    }

    async function doConnect(id) {
        const def = getServer(id);
        if (!def) { emit(id, 'error', { message: 'Unknown server' }); return false; }
        if (connections.has(id)) return true;
        emit(id, 'connecting');
        try {
            let secrets = {};
            if (def.hasSecrets) {
                secrets = resolveSecrets(id);
                if (secrets === null) throw new Error('Stored secrets could not be decrypted — re-enter them in the server settings.');
            }
            const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
            let transport;
            if (def.transport === 'http') {
                const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
                transport = new StreamableHTTPClientTransport(new URL(def.url), {
                    requestInit: { headers: secrets.headers ?? {} },
                });
            } else {
                const { StdioClientTransport, getDefaultEnvironment } = await import('@modelcontextprotocol/sdk/client/stdio.js');
                transport = new StdioClientTransport({
                    command: def.command,
                    args: def.args ?? [],
                    env: { ...getDefaultEnvironment(), ...(secrets.env ?? {}) },
                });
            }
            const client = new Client({ name: 'moon-agent', version: '1.0.0' }, { capabilities: {} });
            transport.onclose = () => {
                if (connections.delete(id)) emit(id, 'disconnected');
            };
            await client.connect(transport);
            const { tools } = await client.listTools();
            connections.set(id, { client, tools, serverName: def.name });
            emit(id, 'connected', { toolCount: tools.length });
            return true;
        } catch (e) {
            connections.delete(id);
            emit(id, 'error', { message: e.message });
            return false;
        }
    }

    async function disconnect(id) {
        const conn = connections.get(id);
        if (!conn) return;
        connections.delete(id);
        try { await conn.client.close(); } catch { /* already dead */ }
        emit(id, 'disconnected');
    }

    return {
        connect,
        disconnect,
        async disconnectAll() {
            for (const id of [...connections.keys()]) await disconnect(id);
        },
        forget(id) {
            delete statusMap[id];
        },
        statuses: () => ({ ...statusMap }),
        getAgentTools() {
            const out = {};
            for (const conn of connections.values()) {
                for (const t of conn.tools) {
                    const name = `mcp__${slug(conn.serverName)}__${t.name}`;
                    if (out[name]) console.warn(`[mcp] tool name collision: ${name}`);
                    out[name] = {
                        description: t.description ?? `${t.name} (from ${conn.serverName})`,
                        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
                        execute: async (args) => {
                            const result = await conn.client.callTool({ name: t.name, arguments: args ?? {} });
                            const parts = result?.content ?? [];
                            const text = parts.map((p) => (p.type === 'text' ? p.text : JSON.stringify(p))).join('\n');
                            if (result?.isError) return `Error: ${text || 'tool call failed'}`;
                            return text || '(no content)';
                        },
                    };
                }
            }
            return out;
        },
    };
}
