# Chrome Web Store Listing — Volume Control

Copy/paste these fields into the Web Store developer dashboard.

## Name
Volume Control — Per-Tab Volume Mixer

## Summary (short description, max 132 chars)
Control volume for each browser tab. Mute, duck, or boost any tab up to 150% — with a clean mixer, hotkeys, and per-tab memory.

## Category
Tools  (secondary: Accessibility)

## Language
English

## Single purpose (required by Google)
Volume Control lets the user set an independent volume level and mute state for each browser tab, and boost a tab's volume above 100%.

## Detailed description

Take control of sound in your browser. Volume Control gives every tab its own
volume slider — mute the noisy one, quiet a background video, or boost a too-soft
tab up to 150%.

**Features**
• Per-tab volume — independent level for every audio tab, all at once
• Boost past 100% — up to 150% for tabs that are too quiet
• One-tap mute per tab, plus Mute All / Reset All / Auto-Boost
• A clean liquid-glass mixer that shows every tab playing audio
• Keyboard shortcuts — mute and change the active tab's volume without opening the popup
• Set-and-forget — each tab remembers its setting until you close it
• Works on YouTube, Meet, music sites, video, and more

**Private by design**
No accounts. No tracking. No analytics. No network requests. Everything runs
locally on your machine — your settings never leave your browser.

**Keyboard shortcuts (remap at chrome://extensions/shortcuts)**
• Mute/unmute active tab: Alt+Shift+M (Mac: Option+Shift+M)
• Volume up: Alt+Shift+Up
• Volume down: Alt+Shift+Down

## Permission justifications (paste into the dashboard when asked)

- **tabs** — to list tabs, their titles, icons, and which are playing audio, so they can be shown and controlled in the mixer.
- **storage** — to remember each tab's chosen volume and mute state for the tab's lifetime.
- **scripting + host permissions (<all_urls>)** — to apply the chosen volume to the audio playing on each page. No page content is collected or transmitted.

## Data usage disclosures (Privacy tab)
- Does the extension collect user data? **No.**
- Privacy policy URL: <host privacy-policy.html and paste the URL, e.g. GitHub Pages>

## Notes for submission
- Host `store/privacy-policy.html` somewhere public (GitHub Pages works) and use that URL.
- Upload the 1280×800 images in `store/screenshots/`.
- Icon: `icons/icon128.png` is used automatically from the manifest.
