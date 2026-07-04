// @ts-nocheck
import { ipcMain } from 'electron';

export function registerMcpIpc({ configStore, mcpManager }: { configStore: any; mcpManager: any }) {
  const mcpListShape = () => ({ servers: configStore.getRedacted().mcpServers, statuses: mcpManager.statuses() });

  ipcMain.handle('mcp:list', () => mcpListShape());
  ipcMain.handle('mcp:upsertServer', async (_e, def, rawSecrets) => {
      try {
          // Persist first: if this throws, the running connection (if any)
          // is left untouched and state can't desync. Previously disconnect
          // ran first, so a persist failure left the server disconnected
          // with its old config still on disk — a silent desync.
          const currentStatus = mcpManager.statuses()[def?.id]?.status;
          configStore.upsertMcpServer(def, rawSecrets);
          if (def?.id && (currentStatus === 'connected' || currentStatus === 'connecting')) {
              await mcpManager.disconnect(def.id);
          }
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

  // Fire-and-forget: auto-connect previously-connected MCP servers at startup.
  // Must not block window creation, and a single server failing to connect
  // must not crash the app via an unhandled rejection — allSettled + per-id
  // catch covers both.
  void Promise.allSettled(
    configStore.getConfig().connectedMcpIds.map((id) =>
      mcpManager.connect(id).catch((e) => console.error('[mcp] auto-connect failed', id, e))
    )
  );
}
