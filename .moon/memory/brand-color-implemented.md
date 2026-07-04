---
name: brand-color-implemented
description: Brand accent color #2D6FCD implemented in moon-agent app CSS, replacing prior orange #d77757
type: fact
updated: 2026-07-04T07:28:48.508Z
---

Implemented on 2024 in src/renderer/index.css:
- --accent-color: #2D6FCD (was #d77757 Claude-orange)
- --accent-hover: #6093DC (was #e08868)
- --accent-subtle: rgba(45,111,205,0.12)
- Added full token scale vars --accent-50 through --accent-950 (see prior color-calibration memory for full scale/contrast data)
- All rgba(215,119,87,*) glow/border occurrences in index.css replaced with rgba(45,111,205,*) equivalents (12 occurrences)
- Button text on accent background changed from color:'#000' to color:'#fff' in McpPanel.tsx and SettingsPanel.tsx (3 occurrences) because black-on-brand contrast was 4.27:1 (borderline) vs white-on-brand 4.92:1 (passes AA)
- Updated .commandcode/taste/taste.md learned-taste entry to reflect new brand color instead of stale orange reference
- Verified: no hardcoded hex colors remain in src/renderer/*.tsx (all go through CSS vars); `npx tsc --noEmit` passes clean
- success/warning/danger colors (#34d399/#f59e0b/#ef4444) left unchanged as they're semantic, not brand accent

