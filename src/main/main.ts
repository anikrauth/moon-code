// @ts-nocheck
import { app, BrowserWindow, ipcMain, dialog, safeStorage } from 'electron';
import * as path from 'path';
import { handlePrompt } from './agent';
import { createConfigStore } from './configStore';

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    },
  });

  // Check if we are in dev mode (Vite dev server)
  const isDev = !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  ipcMain.handle('dialog:openDirectory', async () => {
    if (!mainWindow) return null;
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    });
    if (canceled) {
      return null;
    } else {
      return filePaths[0];
    }
  });

  const configStore = createConfigStore({ dir: app.getPath('userData'), safeStorage });

  const configHandler = (fn) => (_event, ...args) => {
    try { fn(...args); } catch (e) { console.error('[config]', e); }
    return configStore.getRedacted();
  };
  ipcMain.handle('config:get', () => configStore.getRedacted());
  ipcMain.handle('config:upsertProfile', configHandler((profile, rawApiKey) => configStore.upsertProfile(profile, rawApiKey)));
  ipcMain.handle('config:deleteProfile', configHandler((id) => configStore.deleteProfile(id)));
  ipcMain.handle('config:setActiveProfile', configHandler((id) => configStore.setActiveProfile(id)));
  ipcMain.handle('config:setSkillIds', configHandler((ids) => configStore.setSkillIds(ids)));
  ipcMain.handle('config:setMcpIds', configHandler((ids) => configStore.setMcpIds(ids)));

  // Tools the user approved with "always allow" for the rest of this app session.
  const sessionAllowedTools = new Set<string>();
  const pendingPermissions = new Map<string, (allow: boolean, alwaysAllow: boolean) => void>();
  let permissionCounter = 0;

  ipcMain.on('agent:prompt', (event, prompt: string, workspace: string, profileId: string, history: any) => {
    const settings = configStore.resolveSettings(profileId);
    if (!settings) {
      event.reply('agent:event', { type: 'error', agent: 'main', content: 'Selected model profile has no API key. Open Settings and configure one.' });
      event.reply('agent:event', { type: 'done' });
      return;
    }
    const requestPermission = (name: string, args: any, agentId: string): Promise<boolean> => {
      if (sessionAllowedTools.has(name)) return Promise.resolve(true);
      const id = `perm-${++permissionCounter}`;
      return new Promise((resolve) => {
        pendingPermissions.set(id, (allow, alwaysAllow) => {
          if (allow && alwaysAllow) sessionAllowedTools.add(name);
          resolve(allow);
        });
        event.reply('agent:event', { type: 'permission_request', id, name, arguments: args, agent: agentId });
      });
    };

    // Call the agent loop and stream results back
    handlePrompt(prompt, workspace, settings, history, (agentEvent) => {
      event.reply('agent:event', agentEvent);
    }, requestPermission);
  });

  ipcMain.on('agent:permission-response', (_event, id: string, allow: boolean, alwaysAllow: boolean) => {
    const resolver = pendingPermissions.get(id);
    if (resolver) {
      pendingPermissions.delete(id);
      resolver(allow, alwaysAllow);
    }
  });

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
