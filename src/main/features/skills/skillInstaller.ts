// @ts-nocheck
import { execFile } from 'child_process';
import { promisify } from 'util';
import { scanSkills } from './skillScanner';

const execFileAsync = promisify(execFile);

// "owner/repo" or "owner/repo@skill" — letters, digits, dot, dash, underscore
// only, and no segment may START with a dot (blocks "." / ".." / ".hidden" and,
// critically, "./evil" — a bare "." would otherwise satisfy `[\w.-]+` and let
// npx treat the spec as a local relative path instead of a package name).
const SPEC_RE = /^[\w-][\w.-]*\/[\w-][\w.-]*(@[\w-][\w.-]*)?$/;

export function isValidSkillSpec(spec) {
  if (typeof spec !== 'string') return false;
  const s = spec.trim();
  // Reject path traversal: `.` is allowed mid-name, so `../evil` matches the
  // shape regex — npx would then treat it as a local path. No `..` ever, and
  // explicitly reject a bare "." or ".." owner/repo segment even though the
  // tightened SPEC_RE above already can't match either (defense-in-depth).
  if (s.includes('..')) return false;
  const [owner, rest] = s.split('/');
  if (owner === '.' || owner === '..') return false;
  const repo = rest?.split('@')[0];
  if (repo === '.' || repo === '..') return false;
  return SPEC_RE.test(s);
}

// Install a skill from the open agent-skills ecosystem via `npx skills add`,
// fully non-interactively, then rescan so callers get the freshly-installed
// skill. Skills land in ~/.agents/skills (the shared ecosystem store the
// scanner already reads). Never throws — returns a result object.
export async function installSkillPackage(spec, workspace, options = {}) {
  const clean = typeof spec === 'string' ? spec.trim() : '';
  if (!isValidSkillSpec(clean)) {
    return { success: false, error: `Invalid skill package spec: "${spec}". Expected "owner/repo" or "owner/repo@skill".` };
  }

  const before = new Set(scanSkills(workspace).map((s) => s.id));
  try {
    const { stdout, stderr } = await execFileAsync(
      'npx',
      ['-y', 'skills', 'add', clean, '-g', '-y'],
      {
        // CI + npm_config_yes suppress the interactive prompts that make the
        // agent's old `run_command` approach hang.
        env: { ...process.env, CI: '1', npm_config_yes: 'true' },
        timeout: options.timeout ?? 120000,
        signal: options.signal,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    const output = ((stdout || '') + (stderr ? `\n${stderr}` : '')).trim();
    const after = scanSkills(workspace);
    const added = after.filter((s) => !before.has(s.id));
    // Prefer the skill whose id matches the requested @skill (or the repo name),
    // then any newly-added skill, then an already-present match (re-install).
    const wanted = clean.includes('@') ? clean.split('@').pop() : clean.split('/').pop();
    const skill = added.find((s) => s.id === wanted) || added[0]
      || after.find((s) => s.id === wanted) || null;
    return { success: true, output, skill };
  } catch (e) {
    const msg = [e?.message, e?.stderr, e?.stdout].filter(Boolean).join('\n').trim();
    return { success: false, error: msg || String(e) };
  }
}
