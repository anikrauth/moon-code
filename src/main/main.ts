// @ts-nocheck
import { app, BrowserWindow, safeStorage } from 'electron';
import * as path from 'path';
import { createConfigStore } from './features/config/configStore';
import { createSessionStore } from './features/sessions/sessionStore';
import { createMcpManager } from './features/mcp/mcpManager';
import { createGitService } from './features/git/gitService';
import { registerDialogIpc } from './app/ipc/registerDialogIpc';
import { registerConfigIpc } from './app/ipc/registerConfigIpc';
import { registerSkillsIpc } from './app/ipc/registerSkillsIpc';
import { registerMcpIpc } from './app/ipc/registerMcpIpc';
import { registerSessionsIpc } from './app/ipc/registerSessionsIpc';
import { registerWorkspaceIpc } from './app/ipc/registerWorkspaceIpc';
import { registerGitIpc } from './app/ipc/registerGitIpc';
import { registerMemoryIpc } from './app/ipc/registerMemoryIpc';
import { registerAgentIpc } from './app/ipc/registerAgentIpc';

app.name = 'Moon Code';

let mainWindow: BrowserWindow | null = null;

const appIconPath = path.join(__dirname, '../../build/icon.png');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 640,
    titleBarStyle: 'hiddenInset',
    icon: appIconPath,
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
  // Packaged builds get their icon from the electron-builder icns; this path
  // only exists in the repo checkout, so setting it there would throw.
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock.setIcon(appIconPath);
  }
  createWindow();

  registerDialogIpc({ getMainWindow: () => mainWindow });

  const configStore = createConfigStore({ dir: app.getPath('userData'), safeStorage });
  registerConfigIpc({ configStore });

  registerSkillsIpc();

  const mcpManager = createMcpManager({
      getServer: (id) => configStore.getRedacted().mcpServers.find((s) => s.id === id),
      resolveSecrets: (id) => configStore.resolveMcpSecrets(id),
      onStatus: (evt) => { mainWindow?.webContents.send('mcp:event', evt); },
  });
  registerMcpIpc({ configStore, mcpManager });

  const sessionStore = createSessionStore({ dir: path.join(app.getPath('userData'), 'sessions') });
  registerSessionsIpc({ sessionStore });

  registerWorkspaceIpc();

  const gitService = createGitService();
  registerGitIpc({ gitService });

  registerMemoryIpc();

  registerAgentIpc({ configStore, mcpManager });

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('before-quit', () => {
    mcpManager.disconnectAll();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
