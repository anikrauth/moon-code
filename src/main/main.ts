// @ts-nocheck
import { app, BrowserWindow, safeStorage, shell } from 'electron';
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

const appIconPath = path.join(
  __dirname,
  process.platform === 'win32' ? '../../build/icon.ico' : '../../build/icon.png'
);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 640,
    // hiddenInset is macOS-only; Windows/Linux keep the standard frame so
    // their native window controls render correctly.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    },
  });

  // Chat markdown renders target="_blank" links; hand http(s) to the OS
  // browser and never spawn a child BrowserWindow from renderer content.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isDevServer = !app.isPackaged && url.startsWith('http://localhost:5173');
    if (!isDevServer && !url.startsWith('file:')) event.preventDefault();
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
  registerGitIpc({ gitService, configStore });

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
