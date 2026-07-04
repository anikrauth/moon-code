// @ts-nocheck
import { ipcMain, shell } from 'electron';
import { initWorkspace } from '../../features/workspace/workspaceInit';
import { resolveInWorkspace } from '../../features/agent/toolRouter';

export function registerWorkspaceIpc() {
  ipcMain.handle('workspace:init', (_event, workspace: string) => {
    try { return initWorkspace(workspace); }
    catch (e) { console.error('[workspace]', e); return { created: false, sources: [] }; }
  });

  // Opens a file citation (`path:line` link in chat) in the OS default
  // editor. `line` isn't passed to the OS opener — most default apps have no
  // universal "open at line" argument — it's accepted for future use once a
  // per-editor launch scheme is added.
  ipcMain.handle('workspace:openFile', async (_event, workspace: string, relPath: string, _line?: number) => {
    try {
      const abs = resolveInWorkspace(workspace, relPath);
      if (!abs) return { ok: false, error: 'Path outside workspace' };
      // openPath resolves to '' on success, an error message on failure.
      const err = await shell.openPath(abs);
      if (err) return { ok: false, error: err };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });
}
