---
name: macos-code-signing-decision
description: moon-code uses ad-hoc macOS signing (no Apple Developer account); users clear quarantine via xattr
type: fact
updated: 2026-07-06T22:38:47.487Z
---

moon-code is an Electron app (electron-builder config inline in package.json under `build`, no separate config file). User decided NOT to buy an Apple Developer account ($99/yr).

Decision: use ad-hoc macOS signing. In package.json build.mac: set `identity: null`, keep `gatekeeperAssess: false`. Removed `hardenedRuntime`, `entitlements`, `entitlementsInherit`, `notarize`. Deleted build/entitlements.mac.plist (only needed for hardened signed builds).

Consequence: builds succeed without Apple creds, but macOS Gatekeeper still shows "Moon Code is damaged and can't be opened" on first launch on non-build machines. Workaround (documented in README): `xattr -cr "/Applications/Moon Code.app"`, or right-click → Open, or System Settings → Privacy & Security → Open Anyway.

To fully remove the warning for all users later: get Apple Developer account, re-add hardened runtime + entitlements plist + notarization.

Env quirk: `node` is not on PATH in this shell — use `python3` for JSON validation.
