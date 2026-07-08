# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| 1.0.x | ✅ Yes |

## Reporting a Vulnerability

If you discover a security vulnerability, **please do NOT open a public GitHub issue.**

Report it privately via email or GitHub's private vulnerability reporting:

- **GitHub:** [Report a vulnerability](https://github.com/ChinhFey/chrome-extension-volume-mixer/security/advisories/new)

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

I will respond within **72 hours** and aim to release a patch within **7 days** for confirmed issues.

## Security Design

Volume Controller is designed with security as a core principle:

- **No remote code execution** — zero external scripts loaded at runtime
- **No network requests** — the extension never makes outbound HTTP calls
- **No data exfiltration** — user data never leaves the browser
- **Manifest V3** — Chrome's most sandboxed extension platform
- **Minimal permissions** — only `tabs`, `storage`, `scripting`
- **Open source** — full code auditable by anyone
- **Per-tab local storage** — settings stored in `chrome.storage.local`, keyed by tab, and cleared when the tab closes
- **No eval()** — no dynamic code execution anywhere in the codebase

## Permissions Justification

| Permission | Why it's needed |
|---|---|
| `tabs` | Read tab titles, favicons, and audible state for the UI |
| `storage` | Remember each tab's volume/mute for the tab's lifetime |
| `scripting` | Inject gain node control into tabs via `executeScript` (MAIN world) |
| `<all_urls>` (host permission) | Required for `scripting.executeScript` to work on any tab |
