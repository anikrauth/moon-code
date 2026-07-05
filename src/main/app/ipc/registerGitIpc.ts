// @ts-nocheck
import { ipcMain } from 'electron';
import { generateCommitMessage } from '../../features/git/commitMessage';

export function registerGitIpc({ gitService, configStore }: { gitService: any; configStore: any }) {
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
  ipcMain.handle('git:generate-commit-message', async (_event, workspace: string, profileId: string) => {
    try {
      const settings = configStore.resolveSettings(profileId);
      if (!settings) return { ok: false, error: 'No API key configured for the active profile. Open Settings.' };
      const changes = await gitService.changesSummary(workspace);
      if (!changes.ok) return changes;
      return await generateCommitMessage(changes.summary, settings, AbortSignal.timeout(30_000));
    } catch (e: any) { console.error('[git]', e); return { ok: false, error: e?.message ?? String(e) }; }
  });
}
