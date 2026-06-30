# TSANet Connect — ZAF Sidebar App (Source Bundle)

A Zendesk Apps Framework (ZAF) sidebar app that embeds TSANet Connect collaboration directly into the Zendesk ticket view.

**Current version:** see [`manifest.json`](manifest.json) and the [latest release](https://github.com/tsanetgit/Zendesk_App/releases).
**Distribution:** Private ZAF app, ZIP upload via Zendesk Admin Center.
**Canonical source:** this repository. The files under `zaf-build/` are edited directly and are exactly what ships — there is no separate source tree that compiles into them.

---

## Two ways to use this bundle

### 1. Install the pre-built app (recommended)

Most members should not build from source. Install the pre-built ZIP that TSANet publishes on each release:

> Admin Center → Apps and integrations → Zendesk Support apps → Upload private app
> Filename: `tsanet-connect-v<version>.zip` — always grab the most recent from the [latest release](https://github.com/tsanetgit/Zendesk_App/releases/latest) (the version matches [`manifest.json`](manifest.json), currently **1.0.42**).

Configure the eight settings (TSANet credentials + your five Zendesk custom field IDs) and you're done. No build tools, no Node, no command line. Five minutes total.

### 2. Customize from this source bundle

If you want to extend the app with company-specific logic (extra panels, additional integrations, branding changes), this source bundle is the starting point.

---

## What's in this bundle

```
zaf-build/
├── manifest.json              ← App metadata, parameters, location
├── README.md                  ← This file
├── assets/
│   ├── index.html             ← Sidebar HTML shell + ZAF SDK CDN script
│   ├── main.js                ← All app logic (single bundled file)
│   ├── background.html        ← Background page (1-min poller, SLA breach detection)
│   └── logo.png               ← App icon (128×128 transparent PNG)
└── translations/
    └── en.json                ← Localization strings (required even if minimal)
```

**About the structure:** This bundle ships a *flat, hand-maintained* JavaScript file (`assets/main.js`, ~840 lines) rather than a multi-file source tree. There is no Vite build step and nothing compiles into it — what you see is what runs in Zendesk. To customize, edit `main.js` directly and repackage (see below).

> **Historical note:** an older multi-file Vite source tree (`shawn-tsanet/tsanet-connect-zendesk-zaf`, under `zaf-app/`) existed but diverged from the shipped app — it had no background poller and older lifecycle logic — and has been **archived read-only**. Do not rebuild from it; doing so will regress live behavior. This repository is the only source of truth.

---

## Editing and packaging

This bundle **is** the source. Edit the files under `zaf-build/` directly; there is no transpile step.

```bash
# 1. Edit the files under zaf-build/ (assets/main.js, index.html,
#    background.html, manifest.json, translations/en.json).
#    main.js has clearly-marked sections:
#      // ── TSANet Auth ─────────   // ── Modal helpers ───────
#      // ── Notes ───────────────   // ── Background sync ─────

# 2. Bump "version" in zaf-build/manifest.json

# 3. Package the installable zip (pure zip of the committed files, no build):
bash scripts/package.sh          # → dist/tsanet-connect-v<version>.zip

# 4. Upload via Admin Center → Apps and integrations → Zendesk Support apps → Update
```

### Releasing

Tag the commit and CI packages the zip and attaches it to a GitHub Release automatically (see [`.github/workflows/release.yml`](../.github/workflows/release.yml)):

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
```

No `npm install`, no `vite build`. The zip is exactly the committed files.

---

## App Settings (filled in on install)

All defaults are intentionally empty. The Zendesk install dialog will block install until required fields are filled.

| Setting | Required | Description |
|---|---|---|
| `tsanet_username` | ✅ | TSANet API user email (e.g. `api@yourcompany.com`) |
| `tsanet_password` | ✅ | TSANet API password |
| `tsanet_env` | ✅ | `BETA` or `PRODUCTION` (default: `BETA`) |
| `field_id_token` | ✅ | Numeric Field ID of your TSANet Token custom field |
| `field_id_tokens_multi` | — | Numeric Field ID of your TSANet Tokens Multi custom field (optional) |
| `field_id_status` | ✅ | Numeric Field ID of your TSANet Status custom field |
| `field_id_partner` | ✅ | Numeric Field ID of your TSANet Partner custom field |
| `field_id_respond_by` | ✅ | Numeric Field ID of your TSANet Respond By custom field |

To find your Field IDs: Admin Center → Objects and rules → Tickets → Fields → click the field → look at the URL (e.g. `…/fields/1234567890`).

---

## Architecture Notes

- **ZAF SDK** loads from Zendesk's CDN at runtime — no local npm install needed.
- **TSANet auth** uses JWT Bearer tokens cached for ~50 minutes; refreshed automatically.
- **Zendesk auth** is automatic — ZAF inherits the agent's session via `client.request()`.
- **No external server** required for the sidebar app itself. Zendesk API calls and the TSANet login both go through the ZAF proxy (`client.request()`); the login uses `secure: true`, so the password is inserted server-side and never appears in browser code. The token-based TSANet calls that follow use a direct browser `fetch()` with the short-lived Bearer JWT, which carries no secret.
- **Background page** (`assets/background.html`) runs while any agent has Zendesk open — polls TSANet every minute for new inbound cases and SLA breaches. The poll interval is the `POLL_INTERVAL_MS` constant; the JWT is cached ~50 min so the interval does not drive login volume. When ZIS push (an authenticated callbackAuth webhook) is registered, push is the primary inbound-ticket creator and the poller defers to it, only backfilling a missing ticket after a grace window.
- **Server-side complement (optional):** a GitHub Actions workflow (separate from this bundle, see ZIS Quick Start) tags tickets on SLA breach when no agent is online. The old ZIS-bearer-token refresh job is retired — ZIS now renews its own Entra tokens — so SLA alerting is the only job this workflow runs, and it's optional convenience (TSANet enforces the acknowledgment SLA server-side regardless).
- **Note visibility is three-way** — the Add Note dialog offers **Internal / Partner only / Public** (`handleAddNote` + `sendPartnerNote`). Partner-only posts the note straight to TSANet with no public Zendesk comment, so the partner sees it and the end customer does not (issue #56). Mirrored notes are labeled by direction — **You** (sent) vs the partner company (received) (issue #62).
- **Stateless** — all state lives in Zendesk ticket fields and the TSANet API. The app holds no database.

---

## Known constraints worth respecting if you customize

These are gotchas that took weeks to discover. Search `main.js` for the named functions to see how they're handled:

- **`prompt()` and `confirm()` are silently blocked** in cross-origin ZAF iframes. Use the `showPrompt()`, `showPrompt2()`, and `showConfirm()` custom modal helpers instead.
- **`engineerEmail` is a required field on Accept** (TSANet API undocumented). Use `settings.tsanet_username` — the agent's Zendesk email won't satisfy domain validation.
- **TSANet returns HTML in note descriptions.** Use `stripHtml()` before display.
- **Zendesk date fields require `YYYY-MM-DD`**, not ISO datetime. Truncate with `.substring(0, 10)`.
- **Notes mirroring uses a `tsanet-note-id:{id}` marker** embedded in Zendesk comment bodies for deduplication. The ZIS field-driven Add Note receipt stamps the **same** marker (issue #69) so the mirror suppresses its duplicate — don't break the marker format or the two paths will double-post.
- **SLA countdown is acknowledgment-only** — gate display on `responded === false`. Once Accepted/Rejected/Info-Requested, TSANet stops tracking the deadline.
- **Close button must be hidden on inbound cases** — TSANet API restricts closure to the submitting party.

For the full list and detailed explanations, see the published `SKILL_TSANet_Connect.md` skill file in the docs repo. If you use Claude Code or another agentic assistant for customization, drop that skill file into `~/.claude/skills/tsanet-connect/SKILL.md` and your assistant will know all of these gotchas before writing a line of code.

---

## License & Contact

Distributed by TSANet for use by member companies.

**Issues, questions, contributions:** membership@tsanet.org
