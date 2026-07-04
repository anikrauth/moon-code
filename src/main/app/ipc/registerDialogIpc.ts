// @ts-nocheck
import { ipcMain, dialog, BrowserWindow } from 'electron';

export function registerDialogIpc({ getMainWindow }: { getMainWindow: () => BrowserWindow | null }) {
  ipcMain.handle('dialog:openDirectory', async () => {
    const mainWindow = getMainWindow();
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
    const mainWindow = getMainWindow();
    if (!mainWindow) return null;
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'Skill files', extensions: ['md'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (canceled) return null;
    return filePaths[0];
  });
}
