const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installSkillPackage, isValidSkillSpec } = require('../dist/main/features/skills/skillInstaller.js');
const { buildInvocableCatalog } = require('../dist/main/features/skills/skillScanner.js');

test('isValidSkillSpec accepts owner/repo and owner/repo@skill only', () => {
  assert.ok(isValidSkillSpec('vercel-labs/agent-skills'));
  assert.ok(isValidSkillSpec('vercel-labs/agent-skills@react-best-practices'));
  assert.ok(!isValidSkillSpec('../evil'));
  assert.ok(!isValidSkillSpec('foo bar'));
  assert.ok(!isValidSkillSpec('-g'));
  assert.ok(!isValidSkillSpec('owner/repo; rm -rf /'));
  assert.ok(!isValidSkillSpec(''));
  assert.ok(!isValidSkillSpec(undefined));
});

test('isValidSkillSpec rejects "." / ".." path-traversal segments (bug #4)', () => {
  // A bare "." satisfies the old [\w.-]+ shape regex as an owner or repo
  // segment, letting npx treat the spec as a local relative path instead of
  // a package name. The tightened regex (segments can't start with ".")
  // plus the explicit owner/repo === "." / ".." reject must both catch these.
  assert.ok(!isValidSkillSpec('./evil'));
  assert.ok(!isValidSkillSpec('./evil@skill'));
  assert.ok(!isValidSkillSpec('owner/.'));
  assert.ok(!isValidSkillSpec('owner/..'));
  assert.ok(!isValidSkillSpec('owner/.@skill'));
  assert.ok(!isValidSkillSpec('./.'));
  assert.ok(!isValidSkillSpec('.hidden/repo'));
  assert.ok(!isValidSkillSpec('owner/.hidden'));
  // Dots are still fine when not leading a segment.
  assert.ok(isValidSkillSpec('my.org/my.repo'));
  assert.ok(isValidSkillSpec('my.org/my.repo@v1.2.3'));
});

test('installSkillPackage rejects an invalid spec without spawning a process', async () => {
  // Regex-gated before execFile: returns fast with an error, never runs npx.
  const res = await installSkillPackage('../evil', process.cwd());
  assert.strictEqual(res.success, false);
  assert.match(res.error, /Invalid skill package spec/);

  const res2 = await installSkillPackage('foo bar', process.cwd());
  assert.strictEqual(res2.success, false);
  assert.match(res2.error, /Invalid skill package spec/);
});

test('buildInvocableCatalog surfaces workspace skills and hides disable-model-invocation ones', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-skills-'));
  const mk = (id, extraFrontmatter) => {
    const dir = path.join(ws, '.moon', 'skills', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'),
      `---\nname: ${id}\ndescription: desc for ${id}\n${extraFrontmatter ?? ''}---\nBody of ${id}.\n`);
  };
  mk('visible-skill');
  mk('hidden-skill', 'disable-model-invocation: true\n');

  const { skillsText, skillsCatalog } = buildInvocableCatalog(ws);
  const ids = skillsCatalog.map((s) => s.id);
  assert.ok(ids.includes('visible-skill'), 'invocable skill is in the catalog');
  assert.ok(!ids.includes('hidden-skill'), 'disable-model-invocation skill is excluded');
  assert.ok(skillsText.includes('AVAILABLE SKILLS'));
  assert.ok(skillsText.includes('visible-skill: desc for visible-skill'));

  fs.rmSync(ws, { recursive: true, force: true });
});
