# Taste (Continuously Learned by [CommandCode][cmd])

[cmd]: https://commandcode.ai/

# ui-ux
- Match Claude Code aesthetic: JetBrains Mono (400/500/600/700) with ligatures, -0.01em letter-spacing, 13px base font. Confidence: 0.70
- Use accent color #d77757 (Claude Code orange). Confidence: 0.70
- Use tight radius scale: --radius-lg: 6px, --radius-md: 4px, --radius-sm: 2px. Confidence: 0.70
- Implement VS Code-style right sidebar with icon rail and content panel. Confidence: 0.70
- Keep the Sessions panel open by default on app launch. Confidence: 0.85

# skills
- Marketplace/installed skills should default to global/personal scope (~/.moon/skills/) so they work across all project workspaces. Confidence: 0.80
- Disk-installed skills should prompt with Cancel = global (~/.moon/skills/) and OK = project (.moon/skills/). Confidence: 0.70
- Skill injection should prepend as system message at start of history, not append. Confidence: 0.70

# npm
- Include marketplace-skills directory in electron-builder files config during packaging. Confidence: 0.70
