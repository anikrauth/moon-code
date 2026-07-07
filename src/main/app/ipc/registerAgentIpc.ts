// @ts-nocheck
import { ipcMain } from 'electron';
import { handlePrompt, forceCompact } from '../../features/agent';
import { buildInvocableCatalog } from '../../features/skills/skillScanner';

// Permission-decision core, factored out of requestPermission below so it
// can be unit-tested directly (no ipcMain/renderer round trip needed) —
// see test/permission-decision.test.js. Behavior is unchanged from the
// inline logic this replaces; this is a pure extraction.
//
// isAlreadyAllowed: whether requestPermission may resolve(true) immediately
// from the session cache without prompting the user. Plan mode's
// run_command gating passes forcePrompt: true to guarantee a fresh prompt
// every call, bypassing the always-allow cache lookup entirely.
export function isAlreadyAllowed(name: string, sessionAllowedTools: Set<string>, forcePrompt: boolean): boolean {
  return !forcePrompt && sessionAllowedTools.has(name);
}

// shouldCacheAllow: whether a user's answer should be written into the
// always-allow cache. An "always allow" answer given while forcePrompt was
// set must NOT be cached — it's recorded as allow-once instead, so a
// plan-mode "always allow" can't silently grease the cache for later
// (execute-mode) calls to the same tool.
export function shouldCacheAllow(allow: boolean, alwaysAllow: boolean, forcePrompt: boolean): boolean {
  return allow && alwaysAllow && !forcePrompt;
}

export function registerAgentIpc({ configStore, mcpManager }: { configStore: any; mcpManager: any }) {
  // Tools the user approved with "always allow" for the rest of this app session.
  const sessionAllowedTools = new Set<string>();
  const pendingPermissions = new Map<string, (allow: boolean, alwaysAllow: boolean) => void>();
  const pendingQuestions = new Map<string, (answer: string | null) => void>();
  let permissionCounter = 0;
  let questionCounter = 0;
  let activeTurn: AbortController | null = null;
  const flushPendingPermissions = () => {
    for (const resolver of pendingPermissions.values()) resolver(false, false);
    pendingPermissions.clear();
  };
  const flushPendingQuestions = () => {
    for (const resolver of pendingQuestions.values()) resolver(null);
    pendingQuestions.clear();
  };

  ipcMain.on('agent:prompt', (event, prompt: string, workspace: string, profileId: string, history: any, meta?: { lastInputTokens?: number; skillContent?: string; sessionId?: string; mode?: 'plan' | 'execute' }) => {
    const settings = configStore.resolveSettings(profileId);
    if (!settings) {
      event.reply('agent:event', { type: 'error', agent: 'main', content: 'Selected model profile has no API key. Open Settings and configure one.' });
      event.reply('agent:event', { type: 'done' });
      return;
    }
    // Call the agent loop and stream results back
    activeTurn?.abort();
    flushPendingPermissions();
    flushPendingQuestions();
    activeTurn = new AbortController();
    const turnController = activeTurn;
    const requestPermission = (name: string, args: any, agentId: string, options?: { forcePrompt?: boolean }): Promise<boolean> => {
      if (turnController.signal.aborted) return Promise.resolve(false);
      // Plan mode's run_command gating passes forcePrompt to guarantee a
      // fresh prompt every call: skip the always-allow cache lookup, and
      // don't let an "always allow" answer given under forcePrompt grease
      // the cache for later (execute-mode) calls — record it as allow-once.
      const forcePrompt = !!options?.forcePrompt;
      if (isAlreadyAllowed(name, sessionAllowedTools, forcePrompt)) return Promise.resolve(true);
      const id = `perm-${++permissionCounter}`;
      return new Promise((resolve) => {
        pendingPermissions.set(id, (allow, alwaysAllow) => {
          if (shouldCacheAllow(allow, alwaysAllow, forcePrompt)) sessionAllowedTools.add(name);
          resolve(allow);
        });
        event.reply('agent:event', { type: 'permission_request', id, name, arguments: args, agent: agentId });
      });
    };
    const requestQuestion = (question: string, options: { label: string; description?: string }[], agentId: string): Promise<string | null> => {
      if (turnController.signal.aborted) return Promise.resolve(null);
      const id = `question-${++questionCounter}`;
      return new Promise((resolve) => {
        pendingQuestions.set(id, (answer) => resolve(answer));
        event.reply('agent:event', { type: 'question', id, question, options, agent: agentId });
      });
    };
    const { skillsText, skillsCatalog } = buildInvocableCatalog(workspace);
    // handlePrompt already has an internal try/catch that emits error+done on
    // failure (defense-in-depth), but guard the call itself too: a rejection
    // thrown before that internal try/catch runs (e.g. a synchronous throw
    // during setup) would otherwise be an unhandled promise rejection here.
    handlePrompt(prompt, workspace, settings, history, (agentEvent) => {
      event.reply('agent:event', agentEvent);
    }, requestPermission, activeTurn.signal, mcpManager.getAgentTools(), skillsText, meta, skillsCatalog, requestQuestion)
      .catch((e: any) => {
        console.error('[agent]', e);
        event.reply('agent:event', { type: 'error', agent: 'main', content: e?.message ?? String(e) });
        event.reply('agent:event', { type: 'done' });
      });
  });

  ipcMain.on('agent:permission-response', (_event, id: string, allow: boolean, alwaysAllow: boolean) => {
    const resolver = pendingPermissions.get(id);
    if (resolver) {
      pendingPermissions.delete(id);
      resolver(allow, alwaysAllow);
    }
  });

  ipcMain.on('agent:question-response', (_event, id: string, answer: string | null) => {
    const resolver = pendingQuestions.get(id);
    if (resolver) {
      pendingQuestions.delete(id);
      resolver(answer);
    }
  });

  ipcMain.on('agent:cancel', () => {
    activeTurn?.abort();
    flushPendingPermissions();
    flushPendingQuestions();
  });

  ipcMain.handle('agent:compact', async (event, profileId: string, history: any) => {
    try {
        const settings = configStore.resolveSettings(profileId);
        if (!settings) return { ok: false, error: 'Selected model profile has no API key.' };
        // Compaction is long-running; the window can close mid-flight and
        // sending to a destroyed webContents throws.
        const compacted = await forceCompact(history ?? [], settings, (e) => {
            if (!event.sender.isDestroyed()) event.sender.send('agent:event', e);
        });
        return { ok: true, history: compacted };
    } catch (e) {
        return { ok: false, error: e?.message ?? String(e) };
    }
  });
}
