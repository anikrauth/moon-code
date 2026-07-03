import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  selectFolder: () => ipcRenderer.invoke('dialog:openDirectory'),
  selectSkill: () => ipcRenderer.invoke('dialog:openSkill'),
  sendPrompt: (prompt: string, workspace: string, profileId: string, history: any, meta?: { lastInputTokens?: number; skillContent?: string }) => ipcRenderer.send('agent:prompt', prompt, workspace, profileId, history, meta),
  respondPermission: (id: string, allow: boolean, alwaysAllow: boolean) => ipcRenderer.send('agent:permission-response', id, allow, alwaysAllow),
  cancelPrompt: () => ipcRenderer.send('agent:cancel'),
  onAgentEvent: (callback: (event: any) => void) => {
    ipcRenderer.removeAllListeners('agent:event');
    ipcRenderer.on('agent:event', (_event, value) => callback(value));
  },
  getConfig: () => ipcRenderer.invoke('config:get'),
  upsertProfile: (profile: any, rawApiKey?: string) => ipcRenderer.invoke('config:upsertProfile', profile, rawApiKey),
  deleteProfile: (id: string) => ipcRenderer.invoke('config:deleteProfile', id),
  setActiveProfile: (id: string) => ipcRenderer.invoke('config:setActiveProfile', id),
  setSkillIds: (ids: string[]) => ipcRenderer.invoke('config:setSkillIds', ids),
  setMcpIds: (ids: string[]) => ipcRenderer.invoke('config:setMcpIds', ids),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  getSession: (id: string) => ipcRenderer.invoke('sessions:get', id),
  saveSession: (snapshot: any) => ipcRenderer.invoke('sessions:save', snapshot),
  deleteSession: (id: string) => ipcRenderer.invoke('sessions:delete', id),
  mcpList: () => ipcRenderer.invoke('mcp:list'),
  upsertMcpServer: (def: any, rawSecrets?: any) => ipcRenderer.invoke('mcp:upsertServer', def, rawSecrets),
  deleteMcpServer: (id: string) => ipcRenderer.invoke('mcp:deleteServer', id),
  connectMcp: (id: string) => ipcRenderer.invoke('mcp:connect', id),
  disconnectMcp: (id: string) => ipcRenderer.invoke('mcp:disconnect', id),
  onMcpEvent: (callback: (event: any) => void) => {
    ipcRenderer.removeAllListeners('mcp:event');
    ipcRenderer.on('mcp:event', (_event, value) => callback(value));
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
});
