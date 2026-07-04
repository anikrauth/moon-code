// @ts-nocheck
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function parseFrontmatter(raw) {
  const trimmed = raw.replace(/^﻿/, '');
  if (!trimmed.startsWith('---')) return { meta: {}, body: trimmed };
  const end = trimmed.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: trimmed };
  const fmBlock = trimmed.slice(3, end).trim();
  let bodyStart = trimmed.indexOf('\n', end + 1);
  const body = bodyStart === -1 ? '' : trimmed.slice(bodyStart + 1).trim();

  const meta = {};
  for (const line of fmBlock.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value === 'true') meta[key] = true;
    else if (value === 'false') meta[key] = false;
    else meta[key] = value;
  }
  return { meta, body };
}

function firstParagraph(body) {
  const stripped = body.replace(/^#.*$/m, '').trim();
  const para = stripped.split(/\n\s*\n/)[0] ?? '';
  return para.trim().slice(0, 200);
}

function readSkillDir(dirPath, dirName, source) {
  const skillFile = path.join(dirPath, 'SKILL.md');
  if (!fs.existsSync(skillFile)) return null;
  let raw;
  try {
    raw = fs.readFileSync(skillFile, 'utf-8');
  } catch {
    return null;
  }
  const { meta, body } = parseFrontmatter(raw);
  const id = (meta.name && String(meta.name).trim()) || dirName;
  const description = (meta.description && String(meta.description).trim()) || firstParagraph(body) || 'No description';
  return {
    id,
    name: id,
    description,
    source,
    path: skillFile,
    userInvocable: meta['user-invocable'] !== false,
    disableModelInvocation: meta['disable-model-invocation'] === true,
    content: body,
  };
}

function isDirEntry(entryPath, entry) {
  // Symlinks are how `npx skills add -g` links a shared skill store into an
  // agent-specific directory (e.g. ~/.claude/skills/<name> -> ~/.agents/skills/<name>).
  // Treat symlinked directories the same as real ones or those skills go invisible.
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(entryPath).isDirectory();
  } catch {
    return false;
  }
}

function scanDir(baseDir, source) {
  const results = [];
  if (!baseDir || !fs.existsSync(baseDir)) return results;
  let entries;
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const entryPath = path.join(baseDir, entry.name);
    if (!isDirEntry(entryPath, entry)) continue;
    const skill = readSkillDir(entryPath, entry.name, source);
    if (skill) results.push(skill);
  }
  return results;
}

// Directories the wider agent-skills ecosystem (`npx skills`, Claude Code,
// Cursor, Cline, OpenCode, etc.) reads from and writes to. Scanning these
// directly means a skill installed with `npx skills add -g` is immediately
// visible to Moon Code with no manual symlink step into ~/.moon/skills.
const ECOSYSTEM_DIR_NAMES = ['.agents/skills', '.claude/skills'];

export function scanSkills(workspace) {
  const home = os.homedir();

  // Priority (lowest → highest, later entries in the map win on id collision):
  // ecosystem personal < moon personal < ecosystem project < moon project.
  // Moon-native dirs win because a user managing skills through Moon Code's
  // own UI (Create/Install Skill) should always take precedence over
  // whatever the third-party CLI last synced.
  const layers = [
    ...ECOSYSTEM_DIR_NAMES.map((rel) => scanDir(path.join(home, rel), 'personal')),
    scanDir(path.join(home, '.moon', 'skills'), 'personal'),
    ...(workspace ? ECOSYSTEM_DIR_NAMES.map((rel) => scanDir(path.join(workspace, rel), 'project')) : []),
    workspace ? scanDir(path.join(workspace, '.moon', 'skills'), 'project') : [],
  ];

  const byId = new Map();
  for (const layer of layers) for (const skill of layer) byId.set(skill.id, skill);
  return [...byId.values()];
}

// Single source of truth for the model-facing skill catalog. Progressive
// disclosure (Claude Code / Codex style): the model only sees id + description
// up front (skillsText, injected into the system prompt); full instructions are
// loaded on demand via the `skill` tool. Used both when a turn starts and when
// `install_skill` rescans mid-turn after a new install.
export function buildInvocableCatalog(workspace) {
  const invocable = scanSkills(workspace).filter((s) => !s.disableModelInvocation);
  const skillsText = invocable.length
    ? 'AVAILABLE SKILLS — call the `skill` tool with the id to load full instructions before starting matching work:\n'
      + invocable.map((s) => `- ${s.id}: ${s.description}`).join('\n')
    : '';
  const skillsCatalog = invocable.map((s) => ({ id: s.id, description: s.description, content: s.content }));
  return { skillsText, skillsCatalog };
}
