// @ts-nocheck
import { ipcMain } from 'electron';
import { initWorkspace } from '../../features/workspace/workspaceInit';

export function registerWorkspaceIpc() {
  ipcMain.handle('workspace:init', (_event, workspace: string) => {
    try { return initWorkspace(workspace); }
    catch (e) { console.error('[workspace]', e); return { created: false, sources: [] }; }
  });
}
