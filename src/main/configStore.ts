// @ts-nocheck
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

const emptyConfig = () => ({
    version: 1,
    profiles: [],
    activeProfileId: null,
    activeSkillIds: [],
    connectedMcpIds: [],
    mcpServers: [],
});

export function createConfigStore({ dir, safeStorage }) {
    const file = path.join(dir, 'config.json');
    let config = load();

    function load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
            if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.profiles)) return emptyConfig();
            return { ...emptyConfig(), ...parsed };
        } catch {
            return emptyConfig();
        }
    }

    function persist() {
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
        fs.renameSync(tmp, file);
    }

    function encryptKey(raw) {
        if (safeStorage.isEncryptionAvailable()) {
            return { apiKeyEnc: safeStorage.encryptString(raw).toString('base64'), enc: true };
        }
        console.warn('[moon-code] OS encryption unavailable; storing API key base64-encoded only.');
        return { apiKeyEnc: Buffer.from(raw, 'utf-8').toString('base64'), enc: false };
    }

    function decryptKey(profile) {
        const buf = Buffer.from(profile.apiKeyEnc, 'base64');
        return profile.enc ? safeStorage.decryptString(buf) : buf.toString('utf-8');
    }

    // Advanced per-profile limit overrides: positive finite number or null (unset).
    function limitOverride(v) {
        const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
        return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
    }

    function encryptSecret(raw) {
        if (safeStorage.isEncryptionAvailable()) {
            return { data: safeStorage.encryptString(raw).toString('base64'), enc: true };
        }
        console.warn('[moon-code] OS encryption unavailable; storing secret base64-encoded only.');
        return { data: Buffer.from(raw, 'utf-8').toString('base64'), enc: false };
    }

    function decryptSecret(data, enc) {
        const buf = Buffer.from(data, 'base64');
        return enc ? safeStorage.decryptString(buf) : buf.toString('utf-8');
    }

    return {
        getConfig: () => config,

        getRedacted() {
            return {
                version: config.version,
                activeProfileId: config.activeProfileId,
                activeSkillIds: [...config.activeSkillIds],
                connectedMcpIds: [...config.connectedMcpIds],
                profiles: config.profiles.map(({ apiKeyEnc, enc, ...rest }) => ({ ...rest, hasKey: !!apiKeyEnc })),
                mcpServers: config.mcpServers.map(({ secretsEnc, enc, ...rest }) => ({ ...rest, hasSecrets: !!secretsEnc })),
            };
        },

        upsertProfile(profile, rawApiKey) {
            const existing = profile.id ? config.profiles.find(p => p.id === profile.id) : null;
            const id = existing ? existing.id : `p-${randomUUID()}`;
            const base = {
                id,
                name: profile.name,
                provider: profile.provider,
                model: profile.model,
                baseUrl: profile.baseUrl ?? '',
                contextWindow: limitOverride(profile.contextWindow),
                maxOutputTokens: limitOverride(profile.maxOutputTokens),
            };
            let keyFields;
            if (rawApiKey) keyFields = encryptKey(rawApiKey);
            else if (existing) keyFields = { apiKeyEnc: existing.apiKeyEnc, enc: existing.enc };
            else keyFields = { apiKeyEnc: null, enc: false };
            const next = { ...base, ...keyFields };
            if (existing) config.profiles = config.profiles.map(p => (p.id === id ? next : p));
            else config.profiles.push(next);
            if (!config.activeProfileId) config.activeProfileId = id;
            persist();
            return id;
        },

        deleteProfile(id) {
            config.profiles = config.profiles.filter(p => p.id !== id);
            if (config.activeProfileId === id) {
                config.activeProfileId = config.profiles[0]?.id ?? null;
            }
            persist();
        },

        setActiveProfile(id) {
            if (!config.profiles.some(p => p.id === id)) return;
            config.activeProfileId = id;
            persist();
        },

        setSkillIds(ids) {
            config.activeSkillIds = [...ids];
            persist();
        },

        setMcpIds(ids) {
            config.connectedMcpIds = [...ids];
            persist();
        },

        resolveSettings(profileId) {
            const p = config.profiles.find(x => x.id === profileId);
            if (!p || !p.apiKeyEnc) return null;
            try {
                const apiKey = decryptKey(p);
                if (!apiKey) return null;
                return {
                    apiKey, model: p.model, baseUrl: p.baseUrl,
                    // keys omitted entirely when unset so resolveLimits falls back cleanly
                    ...(p.contextWindow ? { contextWindow: p.contextWindow } : {}),
                    ...(p.maxOutputTokens ? { maxOutputTokens: p.maxOutputTokens } : {}),
                };
            } catch {
                return null;
            }
        },

        upsertMcpServer(def, rawSecrets) {
            const existing = def.id ? config.mcpServers.find((s) => s.id === def.id) : null;
            const id = existing ? existing.id : `m-${randomUUID()}`;
            const base = {
                id, name: def.name, transport: def.transport,
                command: def.command ?? null, args: def.args ?? null, url: def.url ?? null,
            };
            let secretFields;
            if (rawSecrets && Object.keys(rawSecrets).length > 0) {
                const { data, enc } = encryptSecret(JSON.stringify(rawSecrets));
                secretFields = { secretsEnc: data, enc };
            } else if (existing) {
                secretFields = { secretsEnc: existing.secretsEnc, enc: existing.enc };
            } else {
                secretFields = { secretsEnc: null, enc: false };
            }
            const next = { ...base, ...secretFields };
            if (existing) config.mcpServers = config.mcpServers.map((s) => (s.id === id ? next : s));
            else config.mcpServers.push(next);
            persist();
            return id;
        },

        deleteMcpServer(id) {
            config.mcpServers = config.mcpServers.filter((s) => s.id !== id);
            config.connectedMcpIds = config.connectedMcpIds.filter((x) => x !== id);
            persist();
        },

        resolveMcpSecrets(id) {
            const s = config.mcpServers.find((x) => x.id === id);
            if (!s) return null;
            if (!s.secretsEnc) return {};
            try {
                return JSON.parse(decryptSecret(s.secretsEnc, s.enc));
            } catch {
                return null;
            }
        },
    };
}
