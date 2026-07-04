// @ts-nocheck
import { ipcMain } from 'electron';
import { withLock } from './ipcUtils';

export function registerSessionsIpc({ sessionStore }: { sessionStore: any }) {
  // Same #9 hardening as registerConfigIpc: save/delete are the only
  // mutators, shared through one lock so a save and a delete fired close
  // together can't interleave mid-write of index.json.
  const runSessionMutation = withLock((fn: () => any) => {
    try { return fn(); } catch (e) { console.error('[sessions]', e); return undefined; }
  });
  ipcMain.handle('sessions:list', () => {
    try { return sessionStore.listSessions(); } catch (e) { console.error('[sessions]', e); return []; }
  });
  ipcMain.handle('sessions:get', (_event, id: string) => {
    try { return sessionStore.getSession(id); } catch (e) { console.error('[sessions]', e); return null; }
  });
  ipcMain.handle('sessions:save', (_event, snapshot: any) =>
    runSessionMutation(() => sessionStore.saveSession(snapshot)).then((r) => r ?? snapshot?.id ?? null)
  );
  ipcMain.handle('sessions:delete', (_event, id: string) =>
    runSessionMutation(() => sessionStore.deleteSession(id)).then(() => sessionStore.listSessions())
  );
}
