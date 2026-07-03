// @ts-nocheck
import { app, BrowserWindow, ipcMain, dialog, safeStorage } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handlePrompt, forceCompact } from './agent';
import { createConfigStore } from './configStore';
import { createSessionStore } from './sessionStore';
import { createMcpManager } from './mcpManager';
import { SKILL_CATALOG } from '../shared/skillCatalog';
import { scanSkills } from './skillScanner';

app.name = 'Moon Code';

let mainWindow: BrowserWindow | null = null;

const appIconPath = path.join(__dirname, '../../build/icon.png');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
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

  ipcMain.handle('dialog:openSkill', async () => {
    if (!mainWindow) return null;
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'Skill files', extensions: ['md'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (canceled) return null;
    return filePaths[0];
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

  ipcMain.handle('skills:discover', (_e, workspace: string) => {
    try { return scanSkills(workspace); } catch (e) { console.error('[skills]', e); return []; }
  });
  ipcMain.handle('skills:read', (_e, id: string, workspace: string) => {
    try {
      const skill = scanSkills(workspace).find((s) => s.id === id);
      return skill ? { content: skill.content } : null;
    } catch (e) { console.error('[skills]', e); return null; }
  });
  ipcMain.handle('skills:create', (_e, name: string, content: string, scope: 'project' | 'personal', workspace: string) => {
    try {
      const base = scope === 'personal'
        ? path.join(os.homedir(), '.moon', 'skills')
        : path.join(workspace, '.moon', 'skills');
      const dir = path.join(base, name);
      if (fs.existsSync(dir)) {
        throw new Error(`Skill "${name}" already exists.`);
      }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8');
      const skill = scanSkills(workspace).find((s) => s.id === name) ?? null;
      return { success: true, skill };
    } catch (e: any) { console.error('[skills]', e); return { success: false, error: e.message }; }
  });

  ipcMain.handle('skills:install', async (_e, sourcePath: string, scope: 'project' | 'personal', workspace: string) => {
    try {
      const stat = fs.statSync(sourcePath);
      let skillFile: string;
      let targetName: string;
      if (stat.isDirectory()) {
        skillFile = path.join(sourcePath, 'SKILL.md');
        if (!fs.existsSync(skillFile)) throw new Error('Selected directory does not contain a SKILL.md file.');
        targetName = path.basename(sourcePath);
      } else {
        skillFile = sourcePath;
        if (path.basename(sourcePath) !== 'SKILL.md') throw new Error('Selected file must be named SKILL.md.');
        targetName = path.basename(path.dirname(sourcePath));
        if (!targetName || targetName === '.') targetName = 'installed-skill';
      }
      const base = scope === 'personal'
        ? path.join(os.homedir(), '.moon', 'skills')
        : path.join(workspace, '.moon', 'skills');
      const targetDir = path.join(base, targetName);
      if (fs.existsSync(targetDir)) throw new Error(`Skill "${targetName}" already exists.`);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(skillFile, path.join(targetDir, 'SKILL.md'));
      const skill = scanSkills(workspace).find((s) => s.id === targetName) ?? null;
      return { success: true, skill };
    } catch (e: any) { console.error('[skills]', e); return { success: false, error: e.message }; }
  });

  ipcMain.handle('skills:installMarketplace', async (_e, skillId: string, workspace: string) => {
    try {
      const { SKILL_MARKETPLACE } = require('../shared/skillMarketplace');
      const entry = SKILL_MARKETPLACE.find((s: any) => s.id === skillId);
      if (!entry) throw new Error(`Marketplace skill "${skillId}" not found.`);
      if (entry.source === 'bundled') {
        const bundledPath = path.join(app.getAppPath(), entry.bundledPath);
        if (!fs.existsSync(bundledPath)) {
          // Fallback for development when running from source without a packaged app path
          const devPath = path.join(__dirname, '..', '..', entry.bundledPath);
          if (fs.existsSync(devPath)) {
            const skill = copySkillToPersonal(devPath, skillId, workspace);
            return { success: true, skill };
          }
          throw new Error(`Bundled skill file missing: ${bundledPath}`);
        }
        const skill = copySkillToPersonal(bundledPath, skillId, workspace);
        return { success: true, skill };
      }
      throw new Error(`Unsupported marketplace source: ${entry.source}`);
    } catch (e: any) { console.error('[skills]', e); return { success: false, error: e.message }; }
  });

  ipcMain.handle('skills:installFromUrl', async (_e, url: string, workspace: string) => {
    try {
      if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
        throw new Error('URL must start with http:// or https://');
      }
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
      const content = await res.text();
      if (!content.trim().startsWith('---')) throw new Error('Downloaded file does not look like a SKILL.md (missing frontmatter).');
      const id = extractSkillId(content, url);
      const base = path.join(os.homedir(), '.moon', 'skills');
      const targetDir = path.join(base, id);
      if (fs.existsSync(targetDir)) throw new Error(`Skill "${id}" already exists.`);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'SKILL.md'), content, 'utf-8');
      const skill = scanSkills(workspace).find((s) => s.id === id) ?? null;
      return { success: true, skill };
    } catch (e: any) { console.error('[skills]', e); return { success: false, error: e.message }; }
  });

  function extractSkillId(content: string, url: string): string {
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    if (nameMatch) {
      const id = nameMatch[1].trim().replace(/^["']|["']$/g, '');
      if (id) return id;
    }
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      const last = parts[parts.length - 1] ?? '';
      if (last && last !== 'SKILL.md') return last.replace(/\.md$/i, '');
      const parent = parts[parts.length - 2] ?? '';
      if (parent) return parent;
    } catch { /* ignore */ }
    return 'installed-skill';
  }

  function copySkillToPersonal(skillFile: string, targetName: string, workspace: string) {
    const base = path.join(os.homedir(), '.moon', 'skills');
    const targetDir = path.join(base, targetName);
    if (fs.existsSync(targetDir)) throw new Error(`Skill "${targetName}" already exists.`);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(skillFile, path.join(targetDir, 'SKILL.md'));
    return scanSkills(workspace).find((s) => s.id === targetName) ?? null;
  }

  const mcpManager = createMcpManager({
      getServer: (id) => configStore.getRedacted().mcpServers.find((s) => s.id === id),
      resolveSecrets: (id) => configStore.resolveMcpSecrets(id),
      onStatus: (evt) => { mainWindow?.webContents.send('mcp:event', evt); },
  });
  const mcpListShape = () => ({ servers: configStore.getRedacted().mcpServers, statuses: mcpManager.statuses() });

  ipcMain.handle('mcp:list', () => mcpListShape());
  ipcMain.handle('mcp:upsertServer', async (_e, def, rawSecrets) => {
      try {
          const currentStatus = mcpManager.statuses()[def?.id]?.status;
          if (def?.id && (currentStatus === 'connected' || currentStatus === 'connecting')) {
              await mcpManager.disconnect(def.id);
          }
          configStore.upsertMcpServer(def, rawSecrets);
      } catch (e) { console.error('[mcp]', e); }
      return mcpListShape();
  });
  ipcMain.handle('mcp:deleteServer', async (_e, id) => {
      try { await mcpManager.disconnect(id); mcpManager.forget(id); configStore.deleteMcpServer(id); } catch (e) { console.error('[mcp]', e); }
      return mcpListShape();
  });
  ipcMain.handle('mcp:connect', async (_e, id) => {
      try {
          const ok = await mcpManager.connect(id);
          if (ok) {
              const ids = new Set(configStore.getConfig().connectedMcpIds); ids.add(id);
              configStore.setMcpIds([...ids]);
          }
      } catch (e) { console.error('[mcp]', e); }
      return mcpListShape();
  });
  ipcMain.handle('mcp:disconnect', async (_e, id) => {
      try {
          await mcpManager.disconnect(id);
          configStore.setMcpIds(configStore.getConfig().connectedMcpIds.filter((x) => x !== id));
      } catch (e) { console.error('[mcp]', e); }
      return mcpListShape();
  });

  for (const id of configStore.getConfig().connectedMcpIds) mcpManager.connect(id);

  const sessionStore = createSessionStore({ dir: path.join(app.getPath('userData'), 'sessions') });
  ipcMain.handle('sessions:list', () => {
    try { return sessionStore.listSessions(); } catch (e) { console.error('[sessions]', e); return []; }
  });
  ipcMain.handle('sessions:get', (_event, id: string) => {
    try { return sessionStore.getSession(id); } catch (e) { console.error('[sessions]', e); return null; }
  });
  ipcMain.handle('sessions:save', (_event, snapshot: any) => {
    try { return sessionStore.saveSession(snapshot); } catch (e) { console.error('[sessions]', e); return snapshot?.id ?? null; }
  });
  ipcMain.handle('sessions:delete', (_event, id: string) => {
    try { sessionStore.deleteSession(id); } catch (e) { console.error('[sessions]', e); }
    return sessionStore.listSessions();
  });

  // Tools the user approved with "always allow" for the rest of this app session.
  const sessionAllowedTools = new Set<string>();
  const pendingPermissions = new Map<string, (allow: boolean, alwaysAllow: boolean) => void>();
  let permissionCounter = 0;
  let activeTurn: AbortController | null = null;
  const flushPendingPermissions = () => {
    for (const resolver of pendingPermissions.values()) resolver(false, false);
    pendingPermissions.clear();
  };

  ipcMain.on('agent:prompt', (event, prompt: string, workspace: string, profileId: string, history: any, meta?: { lastInputTokens?: number; skillContent?: string }) => {
    const settings = configStore.resolveSettings(profileId);
    if (!settings) {
      event.reply('agent:event', { type: 'error', agent: 'main', content: 'Selected model profile has no API key. Open Settings and configure one.' });
      event.reply('agent:event', { type: 'done' });
      return;
    }
    // Call the agent loop and stream results back
    activeTurn?.abort();
    flushPendingPermissions();
    activeTurn = new AbortController();
    const turnController = activeTurn;
    const requestPermission = (name: string, args: any, agentId: string): Promise<boolean> => {
      if (turnController.signal.aborted) return Promise.resolve(false);
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
    const activeSkills = configStore.getConfig().activeSkillIds
        .map((sid) => SKILL_CATALOG.find((s) => s.id === sid))
        .filter(Boolean);
    const bundledSkillsText = activeSkills.length
        ? 'ACTIVE SKILLS — follow these working practices:\n\n' + activeSkills.map((s) => `${s.name}:\n${s.instructions}`).join('\n\n')
        : '';
    const discovered = scanSkills(workspace);
    const invocableSkills = discovered.filter((s) => !s.disableModelInvocation);
    // Progressive disclosure (Claude Code / Codex style): the model only sees
    // id + description up front. Full instructions are loaded on demand via
    // the `skill` tool (see agent.ts), not inlined into the prompt.
    const catalogText = invocableSkills.length
        ? 'AVAILABLE SKILLS — call the `skill` tool with the id to load full instructions before starting matching work:\n' + invocableSkills.map((s) => `- ${s.id}: ${s.description}`).join('\n')
        : '';
    const skillsText = [bundledSkillsText, catalogText].filter(Boolean).join('\n\n');
    const skillsCatalog = invocableSkills.map((s) => ({ id: s.id, description: s.description, content: s.content }));
    handlePrompt(prompt, workspace, settings, history, (agentEvent) => {
      event.reply('agent:event', agentEvent);
    }, requestPermission, activeTurn.signal, mcpManager.getAgentTools(), skillsText, meta, skillsCatalog);
  });

  ipcMain.on('agent:permission-response', (_event, id: string, allow: boolean, alwaysAllow: boolean) => {
    const resolver = pendingPermissions.get(id);
    if (resolver) {
      pendingPermissions.delete(id);
      resolver(allow, alwaysAllow);
    }
  });

  ipcMain.on('agent:cancel', () => {
    activeTurn?.abort();
    flushPendingPermissions();
  });

  ipcMain.handle('agent:compact', async (event, profileId: string, history: any) => {
    try {
        const settings = configStore.resolveSettings(profileId);
        if (!settings) return { ok: false, error: 'Selected model profile has no API key.' };
        const compacted = await forceCompact(history ?? [], settings, (e) => event.sender.send('agent:event', e));
        return { ok: true, history: compacted };
    } catch (e) {
        return { ok: false, error: e?.message ?? String(e) };
    }
  });

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
