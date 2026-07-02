import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  selectFolder: () => ipcRenderer.invoke('dialog:openDirectory'),
  sendPrompt: (prompt: string, workspace: string, profileId: string, history: any) => ipcRenderer.send('agent:prompt', prompt, workspace, profileId, history),
  respondPermission: (id: string, allow: boolean, alwaysAllow: boolean) => ipcRenderer.send('agent:permission-response', id, allow, alwaysAllow),
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
});
