# Chrome Web Store — Submission Checklist

Everything needed to publish Volume Control. Work top to bottom.

## 1. Host the privacy policy (required)
Google requires a public privacy-policy URL because the extension uses broad host
permissions.
- [ ] Publish `store/privacy-policy.html` at a public URL. Easiest: GitHub Pages.
  - Repo → Settings → Pages → deploy from `main` → `/root` (or a `/docs` folder).
  - URL will be like `https://chinhfey.github.io/chrome-extension-volume-mixer/store/privacy-policy.html`.
- [ ] Paste that URL into the store listing's Privacy tab.

## 2. Package the extension
- [ ] From the repo root, zip the runtime files only (not docs/tests):
  ```bash
  zip -r volume-control.zip manifest.json background.js content.js injected.js \
      popup.html popup.css popup.js icons
  ```
- [ ] The zip's top level must contain `manifest.json` (it does with the command above).

## 3. Create the item
- [ ] Go to the Chrome Web Store Developer Dashboard (one-time $5 registration fee).
- [ ] "Add new item" → upload `volume-control.zip`.

## 4. Store listing (copy from `store/listing.md`)
- [ ] Name, Summary, Detailed description, Category = Tools.
- [ ] Screenshots: upload `store/screenshots/1-mixer.png`, `2-boost.png`, `3-private.png` (1280×800).
- [ ] Icon is taken from the manifest (`icons/icon128.png`) automatically.

## 5. Privacy & permissions
- [ ] "Collects user data?" → **No**.
- [ ] Privacy policy URL → the one from step 1.
- [ ] Permission justifications: paste from `store/listing.md`.
- [ ] Single-purpose description: paste from `store/listing.md`.

## 6. Submit
- [ ] Save draft → Submit for review. First review typically takes a few days.
- [ ] Broad host permissions (`<all_urls>`) may draw extra scrutiny — the single-purpose
      statement and permission justifications above are written to address that.

## Notes / gotchas
- Version bumps: increase `manifest.json` `version` before each re-upload.
- Do NOT include `store/`, `docs/`, `test/`, or `node_modules` in the zip.
- If review flags host permissions, emphasize: volume is applied by injecting a gain
  into the page's own audio; no page content is read or transmitted.
