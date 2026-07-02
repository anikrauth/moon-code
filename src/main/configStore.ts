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
        console.warn('[moon-agent] OS encryption unavailable; storing API key base64-encoded only.');
        return { apiKeyEnc: Buffer.from(raw, 'utf-8').toString('base64'), enc: false };
    }

    function decryptKey(profile) {
        const buf = Buffer.from(profile.apiKeyEnc, 'base64');
        return profile.enc ? safeStorage.decryptString(buf) : buf.toString('utf-8');
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
                return { apiKey, model: p.model, baseUrl: p.baseUrl };
            } catch {
                return null;
            }
        },
    };
}
