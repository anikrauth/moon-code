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
    if (!entry.isDirectory()) continue;
    const skill = readSkillDir(path.join(baseDir, entry.name), entry.name, source);
    if (skill) results.push(skill);
  }
  return results;
}

export function scanSkills(workspace) {
  const projectSkills = workspace ? scanDir(path.join(workspace, '.moon', 'skills'), 'project') : [];
  const personalSkills = scanDir(path.join(os.homedir(), '.moon', 'skills'), 'personal');

  const byId = new Map();
  for (const skill of personalSkills) byId.set(skill.id, skill);
  for (const skill of projectSkills) byId.set(skill.id, skill); // project overrides personal
  return [...byId.values()];
}
