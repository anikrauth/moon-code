// @ts-nocheck
import React, { useState } from 'react';
import { X, Search, Puzzle, Zap, Check, Plus } from 'lucide-react';
import { SKILL_CATALOG } from '../shared/skillCatalog';

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface SkillsPanelProps {
  open: boolean;
  onClose: () => void;
  activeSkillIds: string[];
  onToggleSkill: (skill: any) => void;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function SkillsPanel({ open, onClose, activeSkillIds, onToggleSkill }: SkillsPanelProps) {
  const [search, setSearch] = useState('');

  if (!open) return null;

  const filtered = SKILL_CATALOG.filter(
    (s) =>
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.description.toLowerCase().includes(search.toLowerCase()) ||
      s.category.toLowerCase().includes(search.toLowerCase()),
  );

  const categories = [...new Set(filtered.map((s) => s.category))];

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="skills-panel glass-panel">
        {/* Header */}
        <div className="sp-header">
          <div className="sp-header-title">
            <Puzzle size={18} />
            <h3>Skills</h3>
          </div>
          <button className="sp-close" onClick={onClose} aria-label="Close skills panel">
            <X size={16} />
          </button>
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
            autoFocus
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
          {filtered.length === 0 && (
            <div className="sp-empty">No skills match your search.</div>
          )}
        </div>
      </div>
    </div>
  );
}
