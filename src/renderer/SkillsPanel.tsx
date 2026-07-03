// @ts-nocheck
import React, { useState } from 'react';
import { Search, Puzzle, Zap, Check, Plus, FileText } from 'lucide-react';
import { SKILL_CATALOG } from '../shared/skillCatalog';

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface SkillsPanelProps {
  activeSkillIds: string[];
  onToggleSkill: (skill: any) => void;
  discoveredSkills?: any[];
  invokedSkillIds?: string[];
  onInvokeSkill?: (id: string) => void;
  onCreateSkill?: () => void;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function SkillsPanel({
  activeSkillIds,
  onToggleSkill,
  discoveredSkills = [],
  invokedSkillIds = [],
  onInvokeSkill,
  onCreateSkill,
}: SkillsPanelProps) {
  const [search, setSearch] = useState('');

  const filtered = SKILL_CATALOG.filter(
    (s) =>
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.description.toLowerCase().includes(search.toLowerCase()) ||
      s.category.toLowerCase().includes(search.toLowerCase()),
  );
  const filteredDiscovered = discoveredSkills.filter(
    (s) =>
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.description.toLowerCase().includes(search.toLowerCase()),
  );

  const categories = [...new Set(filtered.map((s) => s.category))];

  return (
    <>
      {/* Header */}
      <div className="sp-header">
        <div className="sp-header-title">
          <Puzzle size={18} />
          <h3>Skills</h3>
        </div>
      </div>

      {/* Search */}
      <div className="sp-search-wrap">
        <Search size={14} className="sp-search-icon" />
        <input
          type="text"
          className="sp-search"
          placeholder="Search skills..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Catalog */}
      <div className="sp-catalog">
        {categories.map((cat) => (
          <div key={cat} className="sp-category">
            <span className="sp-category-label">{cat}</span>
            {filtered
              .filter((s) => s.category === cat)
              .map((skill) => {
                const isActive = activeSkillIds.includes(skill.id);
                return (
                  <button
                    key={skill.id}
                    className={`sp-skill-row ${isActive ? 'sp-skill-active' : ''}`}
                    onClick={() => onToggleSkill(skill)}
                  >
                    <div className="sp-skill-info">
                      <Zap size={14} className="sp-skill-icon" />
                      <div>
                        <span className="sp-skill-name">{skill.name}</span>
                        <span className="sp-skill-desc">{skill.description}</span>
                      </div>
                    </div>
                    <span className="sp-skill-toggle">
                      {isActive ? <Check size={14} /> : <Plus size={14} />}
                    </span>
                  </button>
                );
              })}
          </div>
        ))}

        {filteredDiscovered.length > 0 && (
          <div className="sp-category">
            <span className="sp-category-label">From .moon/skills</span>
            {filteredDiscovered.map((skill) => {
              const invoked = invokedSkillIds.includes(skill.id);
              return (
                <button
                  key={skill.id}
                  className="sp-skill-row"
                  onClick={() => onInvokeSkill?.(skill.id)}
                  title={`Invoke /${skill.id}`}
                >
                  <div className="sp-skill-info">
                    <FileText size={14} className="sp-skill-icon" />
                    <div>
                      <span className="sp-skill-name">
                        {skill.name} <span className="sp-source-tag">{skill.source}</span>
                      </span>
                      <span className="sp-skill-desc">{skill.description}</span>
                    </div>
                  </div>
                  {invoked && <span className="sp-invoked-badge">Invoked</span>}
                </button>
              );
            })}
          </div>
        )}

        {filtered.length === 0 && filteredDiscovered.length === 0 && (
          <div className="sp-empty">No skills match your search.</div>
        )}
      </div>

      {onCreateSkill && (
        <button className="sp-create-btn" onClick={onCreateSkill}>
          <Plus size={14} /> Create Skill
        </button>
      )}
    </>
  );
}
