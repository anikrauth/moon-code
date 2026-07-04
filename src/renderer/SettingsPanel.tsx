// @ts-nocheck
import React, { useState } from 'react';
import { Settings } from 'lucide-react';
import { resolveLimits } from '../shared/lib/modelLimits';

const providerOptions = [
  { label: 'OpenAI', defaultBase: '', defaultModel: 'gpt-4o' },
  { label: 'Zhipu AI (GLM)', defaultBase: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4' },
  { label: 'OpenRouter', defaultBase: 'https://openrouter.ai/api/v1', defaultModel: 'anthropic/claude-3-opus' },
  { label: 'Cloudflare Workers AI', defaultBase: 'https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1', defaultModel: '@cf/meta/llama-3-8b-instruct' },
  { label: 'Anthropic', defaultBase: 'https://api.anthropic.com/v1', defaultModel: 'claude-3-opus-20240229' },
  { label: 'Custom (OpenAI-Compatible)', defaultBase: '', defaultModel: '' },
];

export default function SettingsPanel({ config, onSetActiveProfile, onSaveProfile, onDeleteProfile }) {
  const [profileForm, setProfileForm] = useState(null); // null closed; {} new; {id,...} edit

  return (
    <>
      <div className="sp-header">
        <div className="sp-header-title"><Settings size={18} /><h3>Settings</h3></div>
      </div>

      {!profileForm ? (
        <div className="sp-catalog">
          {config?.profiles.length === 0 && (
            <div className="sp-empty">No model profiles yet. Add one to start chatting.</div>
          )}
          {config?.profiles.map((p: any) => (
            <div key={p.id} className="mcp-server-row">
              <div className="mcp-server-info">
                <input type="radio" name="active-profile" checked={p.id === config.activeProfileId}
                  onChange={() => onSetActiveProfile(p.id)} />
                <div className="mcp-server-text">
                  <span className="mcp-server-name">
                    {p.name}
                    {!p.hasKey && <span style={{ color: 'var(--danger-color)', fontSize: '11px', marginLeft: '6px' }}>no key</span>}
                  </span>
                  <span className="sp-skill-desc">{p.provider} · {p.model}</span>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <button className="sp-close" aria-label={`Edit ${p.name}`}
                  onClick={() => setProfileForm({ id: p.id, name: p.name, provider: p.provider, model: p.model, baseUrl: p.baseUrl, apiKey: '', hasKey: p.hasKey, contextWindow: p.contextWindow ?? '', maxOutputTokens: p.maxOutputTokens ?? '' })}>
                  Edit
                </button>
                <button className="sp-close" aria-label={`Delete ${p.name}`} onClick={() => onDeleteProfile(p.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
          <button
            className="sp-create-btn"
            onClick={() => setProfileForm({ name: '', provider: 'OpenAI', model: 'gpt-4o', baseUrl: '', apiKey: '', contextWindow: '', maxOutputTokens: '' })}
          >
            Add Model
          </button>
        </div>
      ) : (
        <div className="sp-form">
          <div>
            <label>Profile Name</label>
            <input type="text" value={profileForm.name} onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })} placeholder="e.g. GPT-4o (work)" />
          </div>
          <div>
            <label>Provider</label>
            <select value={profileForm.provider}
              onChange={(e) => {
                const opt = providerOptions.find((p) => p.label === e.target.value);
                setProfileForm(profileForm.id
                  ? { ...profileForm, provider: e.target.value }
                  : { ...profileForm, provider: e.target.value, baseUrl: opt?.defaultBase || '', model: opt?.defaultModel || '' });
              }}>
              {providerOptions.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
            </select>
          </div>
          <div>
            <label>Model Name</label>
            <input type="text" value={profileForm.model} onChange={(e) => setProfileForm({ ...profileForm, model: e.target.value })} placeholder="e.g. gpt-4o" />
          </div>
          <div>
            <label>Base URL (Optional)</label>
            <input type="text" value={profileForm.baseUrl} onChange={(e) => setProfileForm({ ...profileForm, baseUrl: e.target.value })} placeholder="Override endpoint URL..." />
          </div>
          <div>
            <label>API Key</label>
            <input type="password" value={profileForm.apiKey} onChange={(e) => setProfileForm({ ...profileForm, apiKey: e.target.value })}
              placeholder={profileForm.hasKey ? '•••••••• (leave blank to keep)' : 'Enter your API Key...'} />
          </div>
          <div>
            <label>Context Window (Optional)</label>
            <input type="number" min="1" value={profileForm.contextWindow ?? ''}
              onChange={(e) => setProfileForm({ ...profileForm, contextWindow: e.target.value })}
              placeholder={`Default: ${resolveLimits(profileForm.model).contextWindow.toLocaleString()}`} />
          </div>
          <div>
            <label>Max Output Tokens (Optional)</label>
            <input type="number" min="1" value={profileForm.maxOutputTokens ?? ''}
              onChange={(e) => setProfileForm({ ...profileForm, maxOutputTokens: e.target.value })}
              placeholder={`Default: ${resolveLimits(profileForm.model).maxOutputTokens.toLocaleString()}`} />
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="glass-panel" style={{ padding: '8px', cursor: 'pointer', color: 'var(--text-primary)', flexGrow: 1 }} onClick={() => setProfileForm(null)}>Cancel</button>
            <button
              style={{ background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', padding: '8px', cursor: 'pointer', fontWeight: 600, flexGrow: 1 }}
              disabled={!profileForm.name.trim() || !profileForm.model.trim()}
              onClick={() => {
                const { apiKey, hasKey, ...profile } = profileForm;
                onSaveProfile(profile, apiKey || undefined);
                setProfileForm(null);
              }}>
              Save Model
            </button>
          </div>
        </div>
      )}
    </>
  );
}
