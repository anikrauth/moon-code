import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  selectFolder: () => ipcRenderer.invoke('dialog:openDirectory'),
  sendPrompt: (prompt: string, workspace: string, settings: any, history: any) => ipcRenderer.send('agent:prompt', prompt, workspace, settings, history),
  onAgentEvent: (callback: (event: any) => void) => {
    ipcRenderer.removeAllListeners('agent:event');
    ipcRenderer.on('agent:event', (_event, value) => callback(value));
  }
});
