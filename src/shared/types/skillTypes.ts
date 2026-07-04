export interface DiscoveredSkill {
  id: string;
  name: string;
  description: string;
  source: 'project' | 'personal';
  path: string;
  userInvocable: boolean;
  disableModelInvocation: boolean;
  content: string;
}

export interface BundledSkill {
  id: string;
  name: string;
  category: string;
  description: string;
  instructions: string;
}
