import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  selectFolder: () => ipcRenderer.invoke('dialog:openDirectory'),
  selectSkill: () => ipcRenderer.invoke('dialog:openSkill'),
  sendPrompt: (prompt: string, workspace: string, profileId: string, history: any, meta?: { lastInputTokens?: number; skillContent?: string }) => ipcRenderer.send('agent:prompt', prompt, workspace, profileId, history, meta),
  respondPermission: (id: string, allow: boolean, alwaysAllow: boolean) => ipcRenderer.send('agent:permission-response', id, allow, alwaysAllow),
  respondQuestion: (id: string, answer: string | null) => ipcRenderer.send('agent:question-response', id, answer),
  cancelPrompt: () => ipcRenderer.send('agent:cancel'),
  onAgentEvent: (callback: (event: any) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: any) => callback(value);
    ipcRenderer.on('agent:event', handler);
    return () => ipcRenderer.removeListener('agent:event', handler);
  },
  getConfig: () => ipcRenderer.invoke('config:get'),
  upsertProfile: (profile: any, rawApiKey?: string) => ipcRenderer.invoke('config:upsertProfile', profile, rawApiKey),
  deleteProfile: (id: string) => ipcRenderer.invoke('config:deleteProfile', id),
  setActiveProfile: (id: string) => ipcRenderer.invoke('config:setActiveProfile', id),
  setMcpIds: (ids: string[]) => ipcRenderer.invoke('config:setMcpIds', ids),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  getSession: (id: string) => ipcRenderer.invoke('sessions:get', id),
  saveSession: (snapshot: any) => ipcRenderer.invoke('sessions:save', snapshot),
  deleteSession: (id: string) => ipcRenderer.invoke('sessions:delete', id),
  initWorkspace: (workspace: string) =>
    ipcRenderer.invoke('workspace:init', workspace) as Promise<{ created: boolean; sources: string[] }>,
  openFile: (workspace: string, relPath: string, line?: number) =>
    ipcRenderer.invoke('workspace:openFile', workspace, relPath, line) as Promise<{ ok: boolean; error?: string }>,
  gitSnapshot: (workspace: string) => ipcRenderer.invoke('git:snapshot', workspace),
  gitCheckout: (workspace: string, branch: string) =>
    ipcRenderer.invoke('git:checkout', workspace, branch) as Promise<{ ok: boolean; error?: string }>,
  gitCommit: (workspace: string, message: string) =>
    ipcRenderer.invoke('git:commit', workspace, message) as Promise<{ ok: boolean; hash?: string; error?: string }>,
  appendMemory: (scope: 'project' | 'global', text: string, workspace: string) =>
    ipcRenderer.invoke('memory:append', scope, text, workspace) as Promise<{ ok: boolean; error?: string }>,
  listMemory: (workspace: string) => ipcRenderer.invoke('memory:list', workspace),
  openMemory: (scope: 'project' | 'global', workspace: string) =>
    ipcRenderer.invoke('memory:open', scope, workspace) as Promise<{ ok: boolean; error?: string }>,
  mcpList: () => ipcRenderer.invoke('mcp:list'),
  upsertMcpServer: (def: any, rawSecrets?: any) => ipcRenderer.invoke('mcp:upsertServer', def, rawSecrets),
  deleteMcpServer: (id: string) => ipcRenderer.invoke('mcp:deleteServer', id),
  connectMcp: (id: string) => ipcRenderer.invoke('mcp:connect', id),
  disconnectMcp: (id: string) => ipcRenderer.invoke('mcp:disconnect', id),
  onMcpEvent: (callback: (event: any) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: any) => callback(value);
    ipcRenderer.on('mcp:event', handler);
    return () => ipcRenderer.removeListener('mcp:event', handler);
  },
  compactNow: (profileId: string, history: any) => ipcRenderer.invoke('agent:compact', profileId, history),
  discoverSkills: (workspace: string) => ipcRenderer.invoke('skills:discover', workspace),
  readSkill: (id: string, workspace: string) => ipcRenderer.invoke('skills:read', id, workspace),
  createSkill: (name: string, content: string, scope: 'project' | 'personal', workspace: string) =>
    ipcRenderer.invoke('skills:create', name, content, scope, workspace) as Promise<{ success: boolean; skill?: any; error?: string }>,
  installSkill: (sourcePath: string, scope: 'project' | 'personal', workspace: string) =>
    ipcRenderer.invoke('skills:install', sourcePath, scope, workspace) as Promise<{ success: boolean; skill?: any; error?: string }>,
  installMarketplaceSkill: (skillId: string, workspace: string) =>
    ipcRenderer.invoke('skills:installMarketplace', skillId, workspace) as Promise<{ success: boolean; skill?: any; error?: string }>,
  installSkillFromUrl: (url: string, workspace: string) =>
    ipcRenderer.invoke('skills:installFromUrl', url, workspace) as Promise<{ success: boolean; skill?: any; error?: string }>,
  installSkillPackage: (spec: string, workspace: string) =>
    ipcRenderer.invoke('skills:installPackage', spec, workspace) as Promise<{ success: boolean; skill?: any; error?: string }>,
});
