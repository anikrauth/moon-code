// @ts-nocheck
import { app, ipcMain } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanSkills } from '../../features/skills/skillScanner';
import { installSkillPackage } from '../../features/skills/skillInstaller';
import { mkdirExclusive } from './ipcUtils';

export function registerSkillsIpc() {
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
      mkdirExclusive(dir, `Skill "${name}" already exists.`);
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
      mkdirExclusive(targetDir, `Skill "${targetName}" already exists.`);
      fs.copyFileSync(skillFile, path.join(targetDir, 'SKILL.md'));
      const skill = scanSkills(workspace).find((s) => s.id === targetName) ?? null;
      return { success: true, skill };
    } catch (e: any) { console.error('[skills]', e); return { success: false, error: e.message }; }
  });

  ipcMain.handle('skills:installMarketplace', async (_e, skillId: string, workspace: string) => {
    try {
      const { SKILL_MARKETPLACE } = require('../../../shared/config/skillMarketplace');
      const entry = SKILL_MARKETPLACE.find((s: any) => s.id === skillId);
      if (!entry) throw new Error(`Marketplace skill "${skillId}" not found.`);
      if (entry.source === 'bundled') {
        const bundledPath = path.join(app.getAppPath(), entry.bundledPath);
        if (!fs.existsSync(bundledPath)) {
          // Fallback for development when running from source without a packaged app path
          const devPath = path.join(__dirname, '..', '..', '..', '..', entry.bundledPath);
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

  ipcMain.handle('skills:installPackage', async (_e, spec: string, workspace: string) => {
    // Non-interactive `npx skills add` into ~/.agents/skills (shared ecosystem
    // store). Same helper the agent's install_skill tool uses.
    const result = await installSkillPackage(spec, workspace);
    if (!result.success) return { success: false, error: result.error };
    return { success: true, skill: result.skill ?? null };
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
      mkdirExclusive(targetDir, `Skill "${id}" already exists.`);
      fs.writeFileSync(path.join(targetDir, 'SKILL.md'), content, 'utf-8');
      const skill = scanSkills(workspace).find((s) => s.id === id) ?? null;
      return { success: true, skill };
    } catch (e: any) { console.error('[skills]', e); return { success: false, error: e.message }; }
  });
}

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
  mkdirExclusive(targetDir, `Skill "${targetName}" already exists.`);
  fs.copyFileSync(skillFile, path.join(targetDir, 'SKILL.md'));
  return scanSkills(workspace).find((s) => s.id === targetName) ?? null;
}
