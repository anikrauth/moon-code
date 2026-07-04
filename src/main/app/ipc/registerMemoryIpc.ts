// @ts-nocheck
import { ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { memoryStore } from '../../features/memory/memoryStore';

export function registerMemoryIpc() {
  ipcMain.handle('memory:append', (_event, scope: 'project' | 'global', text: string, workspace: string) => {
    try { memoryStore.appendInstruction(scope, workspace, text); return { ok: true }; }
    catch (e: any) { console.error('[memory]', e); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('memory:list', (_event, workspace: string) => {
    try { return memoryStore.buildMemoryCatalog(workspace); } catch (e) { console.error('[memory]', e); return []; }
  });
  ipcMain.handle('memory:open', async (_event, scope: 'project' | 'global', workspace: string) => {
    try {
      const file = memoryStore.instructionPath(scope, workspace);
      if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, scope === 'global' ? '# Moon — global instructions\n' : '# Moon — project instructions\n', 'utf-8');
      }
      const err = await shell.openPath(file);
      return err ? { ok: false, error: err } : { ok: true };
    } catch (e: any) { console.error('[memory]', e); return { ok: false, error: e.message }; }
  });
}
