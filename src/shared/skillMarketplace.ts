// @ts-nocheck
export interface MarketplaceSkill {
  id: string;
  name: string;
  description: string;
  source: 'bundled';
  bundledPath: string;
}

export const SKILL_MARKETPLACE: MarketplaceSkill[] = [
  {
    id: 'define-goal',
    name: 'Define Goal',
    description: 'Turn fuzzy intentions into concrete, measurable objectives before starting work.',
    source: 'bundled',
    bundledPath: 'marketplace-skills/define-goal/SKILL.md',
  },
  {
    id: 'security-best-practices',
    name: 'Security Best Practices',
    description: 'Perform language and framework specific security reviews and suggest improvements.',
    source: 'bundled',
    bundledPath: 'marketplace-skills/security-best-practices/SKILL.md',
  },
  {
    id: 'cli-creator',
    name: 'CLI Creator',
    description: 'Build a composable CLI from API docs, OpenAPI specs, curl examples, or SDKs.',
    source: 'bundled',
    bundledPath: 'marketplace-skills/cli-creator/SKILL.md',
  },
];
