// @ts-nocheck
import { ipcMain } from 'electron';
import { withLock } from './ipcUtils';

export function registerConfigIpc({ configStore }: { configStore: any }) {
  // Shared lock across all config-mutating handlers below (not one per
  // handler) so e.g. an upsertProfile and a setActiveProfile fired back to
  // back are still serialized relative to each other, not just to themselves.
  const runConfigMutation = withLock((fn: (...a: any[]) => void, args: any[]) => {
    try { fn(...args); } catch (e) { console.error('[config]', e); }
    return configStore.getRedacted();
  });
  const configHandler = (fn: (...a: any[]) => void) => (_event: any, ...args: any[]) => runConfigMutation(fn, args);
  ipcMain.handle('config:get', () => configStore.getRedacted());
  ipcMain.handle('config:upsertProfile', configHandler((profile, rawApiKey) => configStore.upsertProfile(profile, rawApiKey)));
  ipcMain.handle('config:deleteProfile', configHandler((id) => configStore.deleteProfile(id)));
  ipcMain.handle('config:setActiveProfile', configHandler((id) => configStore.setActiveProfile(id)));
  ipcMain.handle('config:setMcpIds', configHandler((ids) => configStore.setMcpIds(ids)));
}
