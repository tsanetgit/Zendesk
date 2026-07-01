# ZAF Custom Build Guide (Not Recommended for Most Members)

**Most members should not read this document.** Install the pre-built ZIP from the [latest GitHub Release](https://github.com/tsanetgit/Zendesk_App/releases/latest) instead — see [`ZAF_Quick_Start.md`](ZAF_Quick_Start.md) or [the Implementation Guide](Zendesk_PlainLanguage_Implementation_Guide_v2.15.docx)'s Step 4. That path takes a few minutes, needs no build tools, and is identical for every member, which is what makes centralized support possible.

This document is for the exception: members who **cannot, or will not,** use the pre-built ZIP — most commonly because they want to add company-specific customizations (extra panels, additional integrations, branding changes) on top of the canonical app.

---

## Two ways to build

Most members never build anything. If you're one of the exceptions above, the app ships as a flat, pre-bundled source (the `zaf-build/` directory) — you edit the files directly and re-zip. There is no bundler and no npm build step.

| Capability | With ZAT | Edit bundle directly (no build) |
|---|---|---|
| **Project scaffold** | `zat new` — generates folder structure | Create files manually (or copy from repo) |
| **Local dev server** | `zat server` — HTTPS on :4567 | `zat server` (ZAT path) or upload-and-test |
| **App validation** | `zat validate` — checks manifest | Manual manifest.json review |
| **Bundler** | ZAT's internal webpack | None — flat bundle, no build step |
| **Packaging** | `zat package` — creates ZIP | `scripts/package.sh` |
| **Marketplace submission** | `zat package` → upload | Not needed — private install only |
| **Private installation** | Upload ZIP to Admin Center | Same — same ZIP format |
| **GitHub CI/CD** | Works | Works — no ZAT needed in CI pipeline |
| **Developer familiarity** | ZAT-specific knowledge required | Plain JS — no toolchain at all |
| **Installation requirement** | `npm install -g zendesk_apps_tools` | `npm install -g` (no ZAT) |

The ZAT path is retained mainly for teams scaffolding a separate companion app from scratch. **Edit-bundle-directly is the canonical path** for customizing the TSANet Connect app itself — it's what TSANet's own repo uses.

---

## Path 1: Using ZAT (Zendesk Apps Tool)

### Step 1 — Install ZAT

```bash
npm install -g zendesk_apps_tools
# Verify
zat version
```

### Step 2 — Scaffold the App

```bash
zat new
# When prompted:
# Product: Support
# Location: ticket_sidebar
# App name: TSANet Connect
```

### Step 3 — Local Development

```bash
cd tsanet-connect
zat server
# Open a ticket in Zendesk and append ?zat=true to the URL:
# https://yourcompany.zendesk.com/agent/tickets/123?zat=true
# The app loads from localhost — no install needed during dev
```

### Step 4 — Package for Distribution

```bash
zat package
# Creates: tmp/tsanet-connect-v1.0.0.zip
# ZIP structure Zendesk expects:
# tsanet-connect-v1.0.0.zip
# ├── manifest.json
# └── assets/
#     ├── index.html
#     └── app.js
```

---

## Path 2: Edit the Bundle Directly (No Build Step)

This is the canonical path: the bundle is the source. What you see in `zaf-build/` is exactly what runs in Zendesk — edit `assets/main.js` directly, bump the manifest version, and re-zip. No toolchain to install, nothing to compile.

### Step 1 — Clone Repo and Install Dependencies

```bash
git clone https://github.com/tsanetgit/Zendesk_App.git
cd Zendesk_App/zaf-build
```

### Step 2 — The ZAF SDK (No npm Package Needed)

The ZAF SDK loads from Zendesk's CDN at runtime (`https://static.zdassets.com/zendesk_app_framework_sdk/2.0/zaf_sdk.min.js`) — there's nothing to `npm install` for the SDK itself.

### Step 3 — Local Development (HTTPS Required)

Zendesk requires HTTPS for local app testing. Use `zat server` (works without a scaffolded ZAT project, just to serve the assets), or upload-and-test directly against a dev/Beta Zendesk instance.

### Step 4 — Build and Package

```bash
bash scripts/package.sh
# Produces dist/tsanet-connect-v<version>.zip, reading the version from manifest.json
```

See [`zaf-build/README.md`](zaf-build/README.md) for the full edit-and-package loop, including the "Releasing" workflow (tag push → automatic ZIP build → GitHub Release).

---

## Repository Structure

The app lives in the TSANet GitHub repo at `github.com/tsanetgit/Zendesk_App` (directory: `zaf-build`):

```
zaf-build/
├── manifest.json       ← App metadata, settings definitions, scopes
├── README.md           ← Edit-and-package guide (no build step)
├── assets/
│   ├── index.html      ← Sidebar HTML shell
│   ├── main.js         ← All app logic (single file — edit directly)
│   ├── background.html ← Background poller (inbound + SLA)
│   └── logo.png        ← App icon
└── translations/
    └── en.json         ← Localization strings
```

## The manifest.json — The Most Important File

Zendesk reads this file to understand what the app is, where it appears, what permissions it needs, and what settings the admin must fill in on install. Key settings:

| Field | What It Controls |
|---|---|
| `private: true` | Marks the app as private — not for Marketplace distribution |
| `location: ticket_sidebar` | App appears in the right sidebar on every ticket page |
| `flexible_height: true` | Sidebar expands to fit content rather than a fixed height |
| `frameworkVersion: "2.0"` | Use ZAF SDK v2 — required for `client.request()` API calls |
| `parameters` | Settings the admin fills in on install: TSANet username, password, environment (BETA/PRODUCTION), and the Field IDs of the custom ticket fields |
| `secure: true` on password | Zendesk encrypts this value at rest and never shows it again after the admin saves it |

If you customize the app, lock down your field schema and settings before first distribution to your own members — requirement-created fields (if you migrate to `requirements.json`) are not updatable or deletable once installed.

---

## Distribution Model — No Marketplace

The app is **not** submitted to the Zendesk Marketplace. The source code lives on the TSANet GitHub repository. When a new version is ready, it is built into a ZIP file and installed directly into each member's Zendesk account as a private app. This removes the 4–8 week Marketplace review dependency entirely and gives TSANet full control over distribution and versioning. If you build a custom variant, the same model applies: you distribute your own ZIP to your own Zendesk account(s), privately.

---

## How TSANet Publishes the Canonical Releases (For Reference)

This section describes **TSANet's own** release pipeline — how the official pre-built ZIP you'd otherwise just download comes to exist. It's not something you run if you install the pre-built ZIP; it's background for anyone customizing who wants to understand (or replicate) the same automation for their own fork.

Because the canonical source lives on TSANet's GitHub, the developer workflow is:

1. Developer clones the repo and creates a feature branch
2. Develops and tests locally by editing `zaf-build/` directly (ZAT sideloading optional)
3. Opens a Pull Request to `main` — reviewed by the team
4. PR merged — GitHub Actions automatically builds the ZIP
5. ZIP attached to a GitHub Release — members download and install privately

### Automatic ZIP Packaging on Every Release Tag

```yaml
# .github/workflows/release.yml (already in the repo)
name: Package ZAF app
on:
  push:
    tags: ['v*']
permissions:
  contents: write
jobs:
  package:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bash scripts/package.sh
      - run: gh release upload "$GITHUB_REF_NAME" dist/*.zip
        env: { GH_TOKEN: ${{ github.token }} }
```

This means every version tag automatically produces the official ZIP and attaches it to a GitHub Release for members to download. No developer needs to manually run the build on their local machine. This is a **separate** GitHub Actions workflow from the optional [GitHub Actions SLA Monitor](GitHub_Actions_SLA_Monitor.md) — this one builds and ships the app itself; that one is an optional member-side alerting add-on.

If you maintain a customized fork, you can set up the same pattern in your own repository so your own updates auto-package on tag push.
