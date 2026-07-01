# GitHub Actions SLA Monitor (Optional)

**Status:** optional, external add-on. The core TSANet Connect integration (ZIS connection + flow bundle + ZAF app) is complete and fully functional without this document. Nothing here is required.

---

## What this is and why it's separate

TSANet enforces exactly one SLA — case creation to first acknowledgment — on its own servers, regardless of what Zendesk does. This workflow adds an **email alert inside Zendesk** when that deadline passes; it is alerting convenience, not a requirement.

It is documented on its own, outside the core setup guides, because it is an **external dependency**: it needs its own GitHub repository, GitHub Actions, and stored repository secrets — none of which the core integration requires. If you don't want that footprint, skip this document entirely and either do nothing (TSANet still enforces the SLA server-side) or build your own alerting with Zendesk's native SLA policies.

This is separate from the **Zendesk-side SLA breach trigger** (the trigger that emails the ticket assignee when the `tsanet_sla_breached` tag is added). That trigger is native Zendesk configuration with no external dependency, and stays documented in [`ZAF_Quick_Start.md`](ZAF_Quick_Start.md) (Step 5) and [`SKILL_TSANet_Connect.md`](SKILL_TSANet_Connect.md) — this document only covers the piece that adds the tag from outside Zendesk.

---

## Architecture

```
TSANet API                    Zendesk
──────────────────────────    ─────────────────────────────────────
OPEN cases list          ←── GitHub Actions sla-monitor job
                              (runs at :00 and :50 every hour)
                              Finds overdue cases → tags tickets
                              → Zendesk trigger → email to assignee
```

`sla-monitor` runs on a cron schedule, independent of any agent's browser or any ZIS flow. ZIS flows are event-driven (triggered by Zendesk events), so a scheduled poll doesn't fit that model — GitHub Actions is the simplest and most reliable mechanism for it.

**Why the SLA scope is only OPEN cases:** TSANet SLA is acknowledgment-only. Once a case is Accepted, Rejected, or Info Requested (`responded: true`), TSANet stops tracking it. Checking ACCEPTED/CLOSED cases for SLA breaches would produce false positives.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| TSANet API credentials | Same API user as the ZAF app (`api@yourcompany.com`) |
| Zendesk API token | Admin email + API token |
| GitHub repository + `gh` CLI | [gh install](https://cli.github.com/) |
| TSANet Token field ID | The Zendesk custom field ID for the **TSANet Token** field (same value used in the ZAF app settings) |

---

## Step 1 — Set GitHub Repository Secrets

In your GitHub repository, add the following secrets via the CLI or the GitHub UI (**Settings → Secrets and variables → Actions**):

```bash
gh secret set TSANET_USERNAME      --body "api@yourcompany.com"
gh secret set TSANET_PASSWORD      --body "your-tsanet-api-password"
gh secret set ZENDESK_SUBDOMAIN    --body "yoursubdomain"
gh secret set ZENDESK_EMAIL        --body "admin@yourcompany.com"
gh secret set ZENDESK_API_TOKEN    --body "your-zendesk-api-token"
gh secret set ZENDESK_FIELD_ID_TOKEN --body "your-tsanet-token-field-id"
```

> `ZENDESK_FIELD_ID_TOKEN` is the Zendesk custom field ID for the **TSANet Token** field — the same value you used in the ZAF app settings (e.g. `1234567890` on the dev instance).

---

## Step 2 — Add the Workflow File

Create `.github/workflows/tsanet-maintenance.yml` in your repository:

```yaml
name: TSANet SLA Monitor

on:
  schedule:
    - cron: '0,50 * * * *'   # Every hour at :00 and :50
  workflow_dispatch:           # Allow manual trigger

jobs:
  # ── SLA Breach Monitor ───────────────────────────────────────────────────────
  sla-monitor:
    name: SLA Breach Monitor
    runs-on: ubuntu-latest
    steps:
      - name: Get fresh TSANet JWT
        id: tsanet
        run: |
          RESPONSE=$(curl -s -X POST "https://connect2.tsanet.net/v1/login" \
            -H "Content-Type: application/json" \
            -d "{\"username\":\"${{ secrets.TSANET_USERNAME }}\",\"password\":\"${{ secrets.TSANET_PASSWORD }}\"}")
          JWT=$(echo "$RESPONSE" | jq -r '.accessToken')
          if [ -z "$JWT" ] || [ "$JWT" = "null" ]; then
            echo "TSANet login failed: $RESPONSE"
            exit 1
          fi
          echo "::add-mask::$JWT"
          echo "jwt=$JWT" >> $GITHUB_OUTPUT

      - name: Check for SLA breaches and tag Zendesk tickets
        env:
          TSANET_JWT: ${{ steps.tsanet.outputs.jwt }}
          ZENDESK_AUTH: ${{ secrets.ZENDESK_EMAIL }}/token:${{ secrets.ZENDESK_API_TOKEN }}
          ZENDESK_SUBDOMAIN: ${{ secrets.ZENDESK_SUBDOMAIN }}
          FIELD_ID_TOKEN: ${{ secrets.ZENDESK_FIELD_ID_TOKEN }}
        run: |
          NOW=$(date -u +%s)
          CASES=$(curl -s \
            -H "Authorization: Bearer $TSANET_JWT" \
            "https://connect2.tsanet.net/v1/collaboration-requests?status=OPEN")

          echo "$CASES" | jq -c '.[]?' | while read -r CASE; do
            TOKEN=$(echo "$CASE" | jq -r '.token // empty')
            RESPOND_BY=$(echo "$CASE" | jq -r '.respondBy // empty')
            [ -z "$TOKEN" ] && continue
            [ -z "$RESPOND_BY" ] && continue

            DEADLINE=$(date -d "$RESPOND_BY" +%s 2>/dev/null \
              || date -j -f "%Y-%m-%dT%H:%M:%S" "${RESPOND_BY%.*}" +%s 2>/dev/null)
            [ -z "$DEADLINE" ] && continue
            [ "$DEADLINE" -gt "$NOW" ] && continue

            # Find the matching Zendesk ticket
            SEARCH=$(curl -s -u "$ZENDESK_AUTH" \
              "https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/search.json?query=custom_field_${FIELD_ID_TOKEN}:${TOKEN}%20type:ticket")
            TICKET_ID=$(echo "$SEARCH" | jq -r '.results[0].id // empty')
            [ -z "$TICKET_ID" ] && echo "No ticket for token ${TOKEN:0:8}..." && continue

            # Skip if already tagged (prevents repeat notifications)
            TAGS=$(echo "$SEARCH" | jq -r '.results[0].tags // [] | join(" ")')
            if echo "$TAGS" | grep -q "tsanet_sla_breached"; then
              echo "Ticket #$TICKET_ID already tagged — skipping"
              continue
            fi

            # Tag the ticket — fires the Zendesk SLA breach trigger
            TAG_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
              -X POST -u "$ZENDESK_AUTH" \
              -H "Content-Type: application/json" \
              "https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${TICKET_ID}/tags.json" \
              -d '{"tags":["tsanet_sla_breached"]}')
            echo "Tagged ticket #$TICKET_ID (HTTP $TAG_STATUS)"
          done
```

> **Production vs Beta:** The workflow above uses `connect2.tsanet.net` (Beta). For production, change both `tsanet.net` references to `tsanet.org`.

> **Tag POST is additive** — `POST /api/v2/tickets/{id}/tags.json` preserves existing tags, it doesn't replace them. This is what you want.

> **API version:** the workflow calls `GET /v1/collaboration-requests?status=OPEN`, which still returns 200 (legacy path); `GET /v2/collaboration-requests?status=OPEN` is the current equivalent if you're updating the workflow.

---

## Step 3 — Push and Verify

```bash
git add .github/workflows/tsanet-maintenance.yml
git commit -m "Add TSANet SLA monitor workflow"
git push
```

> If the push is rejected with a `workflow` scope error, run: `gh auth refresh -s workflow`

Then verify:
1. Go to your repo → **Actions** tab
2. Find **TSANet SLA Monitor** → click **Run workflow** to trigger manually
3. The job should complete green within ~30 seconds

---

## Step 4 — Create the Zendesk SLA Breach Trigger

If you haven't already created this as part of the ZAF app setup ([`ZAF_Quick_Start.md`](ZAF_Quick_Start.md) Step 5):

1. Go to **Admin Center → Objects and rules → Business rules → Triggers**
2. Create a trigger named `TSANet SLA Breach — Notify Assignee`
3. Conditions:
   - `Update type` | `is` | `Changed`
   - `Current tags` | `includes` | `tsanet_sla_breached`
4. Action: `Notify user` → `(Assignee)` with appropriate subject and body
5. Save

This fires exactly once per breach — the tag is only added once, and the workflow skips already-tagged tickets on subsequent runs.

---

## Ongoing Maintenance

Almost none. The workflow runs on cron without supervision. Two things to watch:
- Rotate the TSANet API password periodically and update the `TSANET_PASSWORD` secret when you do.
- Watch for failed runs in the Actions tab — most failures are transient (a TSANet API hiccup) and self-resolve on the next run, but a sustained failure usually means an expired secret. Optional: add a notification on workflow failure (GitHub → repo Settings → Notifications, or wire Actions failure to your team Slack via the official Slack GitHub app).

## Retiring this workflow

If you decide the alerting isn't worth the external footprint, delete the repository (or just the workflow file) at any time. TSANet continues to enforce the acknowledgment SLA on its own servers either way — nothing about the core integration depends on this workflow existing.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `sla-monitor` job finds no tickets for breached cases | Check that `ZENDESK_FIELD_ID_TOKEN` matches the TSANet Token field ID used by the ZAF app |
| Trigger fires repeatedly for same ticket | Confirm the trigger condition uses `current_tags` (not `tags`) — wrong field name causes the check to fail silently |
| `gh auth refresh -s workflow` required | GitHub OAuth token was issued without the `workflow` scope — this is a one-time fix |

---

## Historical note — the retired token-refresh job

An earlier version of this workflow also included a `refresh-token` job that kept a static TSANet JWT alive in a ZIS bearer connection (the JWT expires every 60 minutes). That job is retired: ZIS now authenticates to TSANet with Microsoft Entra client credentials and mints/renews its own short-lived tokens, so there is no static token left to refresh. Do not build the refresh-token job or the bearer connection for a new installation — see the ZIS OAuth Client-Credentials Connection section in [`ZIS_Quick_Start.md`](ZIS_Quick_Start.md).
