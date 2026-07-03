// @ts-nocheck
import React from 'react';
import { Puzzle, Globe, History, Gauge, Settings } from 'lucide-react';
import SkillsPanel from './SkillsPanel';
import McpPanel from './McpPanel';
import SessionsPanel from './SessionsPanel';
import SettingsPanel from './SettingsPanel';
import UsagePanel from './UsagePanel';

const TABS = [
  { id: 'skills', icon: Puzzle, label: 'Skills' },
  { id: 'mcp', icon: Globe, label: 'MCP Servers' },
  { id: 'sessions', icon: History, label: 'Sessions' },
  { id: 'usage', icon: Gauge, label: 'Usage' },
];

export default function Sidebar(props: any) {
  const { activeTab, onTabChange } = props;

  const railBtn = (id: string, Icon: any, label: string) => (
    <button
      key={id}
      className={`rail-btn ${activeTab === id ? 'active' : ''}`}
      onClick={() => onTabChange(activeTab === id ? null : id)}
      title={label}
      aria-label={label}
    >
      <Icon size={18} />
    </button>
  );

  return (
    <aside className="sidebar-container">
      <div className="sidebar-rail">
        {TABS.map((t) => railBtn(t.id, t.icon, t.label))}
        <div className="rail-spacer" />
        {railBtn('settings', Settings, 'Settings')}
      </div>
      {activeTab && (
        <div className="sidebar-content">
          {activeTab === 'skills' && (
            <SkillsPanel
              activeSkillIds={props.activeSkillIds}
              onToggleSkill={props.onToggleSkill}
              discoveredSkills={props.discoveredSkills}
              invokedSkillIds={props.invokedSkillIds}
              onInvokeSkill={props.onInvokeSkill}
              onCreateSkill={props.onCreateSkill}
              onInstallSkill={props.onInstallSkill}
              onInstallMarketplaceSkill={props.onInstallMarketplaceSkill}
              onInstallSkillFromUrl={props.onInstallSkillFromUrl}
              skillInstallKey={props.skillInstallKey}
            />
          )}
          {activeTab === 'mcp' && (
            <McpPanel
              servers={props.mcpData.servers}
              statuses={props.mcpData.statuses}
              busy={props.busy}
              onConnect={props.onConnectMcpServer}
              onDisconnect={props.onDisconnectMcpServer}
              onSaveServer={props.onSaveMcpServer}
              onDelete={props.onDeleteMcpServer}
              onAddPreset={props.onAddMcpPreset}
            />
          )}
          {activeTab === 'sessions' && (
            <SessionsPanel
              sessions={props.sessions}
              onSelect={props.onSelectSession}
              onDelete={props.onDeleteSession}
              busy={props.busy}
            />
          )}
          {activeTab === 'usage' && (
            <UsagePanel
              sessionUsage={props.sessionUsage}
              contextInfo={props.contextInfo}
              activeProfile={props.activeProfile}
              activeLimits={props.activeLimits}
            />
          )}
          {activeTab === 'settings' && (
            <SettingsPanel
              config={props.config}
              onSetActiveProfile={props.onSetActiveProfile}
              onSaveProfile={props.onSaveProfile}
              onDeleteProfile={props.onDeleteProfile}
            />
          )}
        </div>
      )}
    </aside>
  );
}
