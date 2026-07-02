// @ts-nocheck
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export function createSessionStore({ dir }) {
    const indexFile = path.join(dir, 'index.json');

    function atomicWrite(file, data) {
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
        fs.renameSync(tmp, file);
    }

    function readIndex() {
        try {
            const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    function writeIndex(entries) {
        entries.sort((a, b) => b.updatedAt - a.updatedAt);
        atomicWrite(indexFile, entries);
    }

    function getSessionById(id) {
        try {
            const parsed = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf-8'));
            return parsed && parsed.id === id ? parsed : null;
        } catch {
            return null;
        }
    }

    return {
        listSessions: () => readIndex(),

        getSession: (id) => getSessionById(id),

        saveSession({ id, title, workspace, messages, history }) {
            const now = Date.now();
            const existing = id ? getSessionById(id) : null;
            const sessionId = existing ? existing.id : `s-${randomUUID()}`;
            const session = {
                id: sessionId,
                title,
                workspace,
                createdAt: existing ? existing.createdAt : now,
                updatedAt: now,
                messages,
                history,
            };
            atomicWrite(path.join(dir, `${sessionId}.json`), session);
            const index = readIndex().filter((e) => e.id !== sessionId);
            index.push({ id: sessionId, title, workspace, updatedAt: now });
            writeIndex(index);
            return sessionId;
        },

        deleteSession(id) {
            try {
                fs.unlinkSync(path.join(dir, `${id}.json`));
            } catch {
                // already gone
            }
            writeIndex(readIndex().filter((e) => e.id !== id));
        },
    };
}
