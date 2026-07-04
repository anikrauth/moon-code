// @ts-nocheck
import { ipcMain } from 'electron';

export function registerGitIpc({ gitService }: { gitService: any }) {
  ipcMain.handle('git:snapshot', async (_event, workspace: string) => {
    try { return await gitService.snapshot(workspace); }
    catch (e) { console.error('[git]', e); return { gitAvailable: true, isRepo: false }; }
  });
  ipcMain.handle('git:checkout', async (_event, workspace: string, branch: string) => {
    try { return await gitService.checkout(workspace, branch); }
    catch (e: any) { console.error('[git]', e); return { ok: false, error: e?.message ?? String(e) }; }
  });
  ipcMain.handle('git:commit', async (_event, workspace: string, message: string) => {
    try { return await gitService.commit(workspace, message); }
    catch (e: any) { console.error('[git]', e); return { ok: false, error: e?.message ?? String(e) }; }
  });
}
