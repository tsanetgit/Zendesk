# TSANet Connect — ZIS & GitHub Actions Quick Start Guide

**Last updated:** May 2026  
**Time to complete:** ~45 minutes

This guide covers two things:

1. **Connecting ZIS to the TSANet API** (Step 4) — so ZIS flows can call TSANet without handling auth themselves. There are two ways to do this:
   - **Option A — OAuth client credentials (Microsoft Entra).** ZIS stores a long-lived client credential and mints/renews short-lived tokens itself. No refresh job, no server. This is the standard method as TSANet rolls it out from development through Beta to Production ([issue #1](https://github.com/tsanetgit/Zendesk/issues/1)).
   - **Option B — Bearer token + GitHub Actions refresh.** The original method: a static TSANet JWT stored in ZIS, kept alive by a scheduled refresh job (the JWT expires every ~60 minutes). Use this only until Option A is enabled for your environment.
2. **SLA Breach Monitor** (Steps 5–8) — a GitHub Actions job that checks for overdue TSANet acknowledgments and tags Zendesk tickets, triggering email alerts to assignees. **Needed on both options** — it is a scheduler concern, independent of how ZIS authenticates.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Zendesk Admin access | Needs API token + ZIS integration management |
| TSANet API credentials | Same API user as the ZAF app (`api@yourcompany.com`) — Option B and the SLA monitor |
| TSANet-issued Entra client | Option A: client ID + secret from TSANet, plus service principal onboarding (contact TSANet with your SP object ID) |
| GitHub repository | Where the Actions workflow will live (SLA monitor; token refresh if on Option B) |
| `gh` CLI | [Install](https://cli.github.com/) — used to set repository secrets |
| ZIS OAuth client | Created in Zendesk Admin Center (see Step 2) |

---

## Architecture Overview

```
ZIS ↔ TSANet connection (pick one)
│
├── Option A: OAuth client credentials (standard going forward)
│     ZIS holds client_id + client_secret (Entra)
│     ZIS mints/renews short-lived tokens itself
│     → no refresh job, nothing scheduled
│
└── Option B: bearer token + GitHub Actions refresh (legacy)
      Job 1: refresh-token (every hour at :00 and :50)
        1. POST /v1/login → TSANet JWT
        2. POST /oauth/tokens → ZIS OAuth token
        3. DELETE old ZIS bearer connection
        4. POST new ZIS bearer connection (fresh JWT)

GitHub Actions — both options
│
└── Job 2: sla-monitor
      1. POST /v1/login → TSANet JWT
      2. GET OPEN collaboration requests
      3. For each past-deadline case:
           - Search Zendesk for ticket by TSANet token
           - POST tag tsanet_sla_breached (if not already tagged)
           → Zendesk trigger fires → emails ticket assignee
```

---

## Step 1 — Create a Zendesk API Token

1. Go to **Admin Center → Apps and integrations → APIs → Zendesk API**
2. Click **Add API token**
3. Give it a description: `TSANet GitHub Actions`
4. Copy the token — you won't see it again

---

## Step 2 — Create a ZIS OAuth Client

ZIS needs an OAuth client to issue short-lived tokens for managing connections.

1. Go to **Admin Center → Apps and integrations → APIs → OAuth clients**
2. Click **Add OAuth client**
3. Fill in:
   - **Client name:** `tsanet_zis_client`
   - **Description:** TSANet ZIS integration OAuth client
   - **Company:** TSANet
   - **Redirect URLs:** `https://yoursubdomain.zendesk.com` (placeholder — not used)
4. Click **Save** and copy the **Client ID** shown

---

## Step 3 — Create the ZIS Integration

The ZIS integration is a named container for TSANet's connections and flows within Zendesk.

Run this once from your terminal (replace values):

```bash
curl -s -X POST \
  "https://YOURSUBDOMAIN.zendesk.com/api/services/zis/integrations" \
  -u "YOUR_EMAIL/token:YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"integration": {"name": "tsanet_connect", "description": "TSANet Connect integration"}}'
```

Expected response:
```json
{ "integration": { "name": "tsanet_connect", ... } }
```

> If you get a 409 Conflict, the integration already exists — that's fine, proceed to Step 4.

---

## Step 4 — Connect ZIS to TSANet

This is the step the rest of the guide exists to support: registering a connection that lets ZIS flows call the TSANet API. All commands below authenticate with a **ZIS OAuth token** — get one first (uses the Client ID from Step 2):

```bash
ZIS_TOKEN=$(curl -s -X POST \
  "https://YOURSUBDOMAIN.zendesk.com/api/v2/oauth/tokens" \
  -u "YOUR_EMAIL/token:YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"token":{"client_id":"YOUR_ZIS_CLIENT_ID","scopes":["read","write"]}}' | jq -r '.token.full_token')
```

### Option A — OAuth client credentials (standard going forward)

Requires the TSANet-issued Entra client (see Prerequisites). ZIS stores the credential and handles all token minting and renewal itself — **skip the refresh-token half of the GitHub Actions workflow entirely.**

**A1. Register the OAuth client** (the API scope goes in `default_scopes`):
```bash
curl -s -X POST \
  "https://YOURSUBDOMAIN.zendesk.com/api/services/zis/connections/oauth/clients/tsanet_connect" \
  -H "Authorization: Bearer $ZIS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "tsanet_entra",
    "grant_type": "client_credentials",
    "client_id": "YOUR_ENTRA_CLIENT_ID",
    "client_secret": "YOUR_ENTRA_CLIENT_SECRET",
    "token_url": "https://login.microsoftonline.com/TENANT_ID/oauth2/v2.0/token",
    "default_scopes": "api://AUDIENCE/.default"
  }'
```
TSANet provides the `TENANT_ID`, `AUDIENCE`, and your client credentials. Paste the secret **verbatim** — Entra secrets can begin with punctuation, and trimming it breaks auth with `AADSTS7000215`.

**A2. Create the connection** (no browser or admin-consent step):
```bash
curl -s -X POST \
  "https://YOURSUBDOMAIN.zendesk.com/api/services/zis/connections/oauth/start/tsanet_connect" \
  -H "Authorization: Bearer $ZIS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"oauth_client_name": "tsanet_entra", "name": "tsanet_oauth"}'
```
The response contains a `redirect_url` with a `verification_code`. **GET that URL (with the same `$ZIS_TOKEN` bearer) to complete creation** — required even for client credentials.

**A3. Verify** — the connection should hold a live `access_token` and a `token_expiry` about an hour out:
```bash
curl -s -H "Authorization: Bearer $ZIS_TOKEN" \
  "https://YOURSUBDOMAIN.zendesk.com/api/services/zis/connections/tsanet_connect?name=tsanet_oauth"
```
ZIS renews the token automatically when it expires. Done — continue to Step 5 for the SLA monitor (you do not need the refresh-token job).

> Gotcha: to change the stored credential later, the endpoint is **`PATCH`** `/api/services/zis/connections/oauth/clients/tsanet_connect/{uuid}` — `PUT` returns 405.

### Option B — Bearer token (legacy; requires the refresh job)

Stores a raw TSANet JWT as a ZIS connection. The JWT expires in ~60 minutes, which is why this option requires the GitHub Actions refresh job in Steps 5–7.

```bash
# 1. Get a TSANet JWT
JWT=$(curl -s -X POST "https://connect2.tsanet.org/v1/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"api@yourcompany.com","password":"YOUR_TSANET_PASSWORD"}' | jq -r '.accessToken')

# 2. Register it as a bearer connection (use connect2.tsanet.net for Beta)
curl -s -X POST \
  "https://YOURSUBDOMAIN.zendesk.com/api/services/zis/connections/bearer_token" \
  -H "Authorization: Bearer $ZIS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"tsanet_api","token":"'"$JWT"'","allowed_domain":"connect2.tsanet.org"}'
```

This connection is now live — for ~60 minutes. Steps 5–7 set up the workflow that keeps it alive.

---

## Step 5 — Set GitHub Repository Secrets

In your GitHub repository, add the following secrets via the CLI or the GitHub UI (**Settings → Secrets and variables → Actions**):

```bash
gh secret set TSANET_USERNAME      --body "api@yourcompany.com"
gh secret set TSANET_PASSWORD      --body "your-tsanet-api-password"
gh secret set ZENDESK_SUBDOMAIN    --body "yoursubdomain"
gh secret set ZENDESK_EMAIL        --body "admin@yourcompany.com"
gh secret set ZENDESK_API_TOKEN    --body "your-zendesk-api-token"
gh secret set ZIS_CLIENT_ID        --body "your-zis-oauth-client-id"
gh secret set ZENDESK_FIELD_ID_TOKEN --body "your-tsanet-token-field-id"
```

> `ZENDESK_FIELD_ID_TOKEN` is the Zendesk custom field ID for the **TSANet Token** field — the same value you used in the ZAF app settings (e.g. `48849323029652` on the dev instance).

---

## Step 6 — Add the Workflow File

> **On Option A?** Delete (or never add) the `refresh-token` job below — ZIS renews its own tokens. Keep only `sla-monitor`.

Create `.github/workflows/tsanet-maintenance.yml` in your repository:

```yaml
name: TSANet Maintenance

on:
  schedule:
    - cron: '0,50 * * * *'   # Every hour at :00 and :50
  workflow_dispatch:           # Allow manual trigger

jobs:
  # ── Job 1: Refresh ZIS Bearer Token ─────────────────────────────────────────
  refresh-token:
    name: Refresh ZIS Bearer Token
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
          echo "TSANet JWT obtained"

      - name: Get ZIS OAuth token
        id: zis
        run: |
          RESPONSE=$(curl -s -X POST \
            "https://${{ secrets.ZENDESK_SUBDOMAIN }}.zendesk.com/api/v2/oauth/tokens" \
            -u "${{ secrets.ZENDESK_EMAIL }}/token:${{ secrets.ZENDESK_API_TOKEN }}" \
            -H "Content-Type: application/json" \
            -d "{\"token\":{\"client_id\":\"${{ secrets.ZIS_CLIENT_ID }}\",\"scopes\":[\"read\",\"write\"]}}")
          ZIS_TOKEN=$(echo "$RESPONSE" | jq -r '.token.full_token')
          if [ -z "$ZIS_TOKEN" ] || [ "$ZIS_TOKEN" = "null" ]; then
            echo "ZIS OAuth token failed: $RESPONSE"
            exit 1
          fi
          echo "::add-mask::$ZIS_TOKEN"
          echo "token=$ZIS_TOKEN" >> $GITHUB_OUTPUT
          echo "ZIS OAuth token obtained"

      - name: Delete expired ZIS connection
        run: |
          HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
            "https://${{ secrets.ZENDESK_SUBDOMAIN }}.zendesk.com/api/services/zis/integrations/tsanet_connect/connections/bearer_token/tsanet_api" \
            -H "Authorization: Bearer ${{ steps.zis.outputs.token }}")
          if [ "$HTTP_STATUS" != "204" ] && [ "$HTTP_STATUS" != "404" ]; then
            echo "Unexpected delete response: $HTTP_STATUS"
            exit 1
          fi
          echo "Old connection removed (status $HTTP_STATUS)"

      - name: Install fresh ZIS connection
        run: |
          HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
            "https://${{ secrets.ZENDESK_SUBDOMAIN }}.zendesk.com/api/services/zis/integrations/tsanet_connect/connections/bearer_token" \
            -H "Authorization: Bearer ${{ steps.zis.outputs.token }}" \
            -H "Content-Type: application/json" \
            -d "{\"name\":\"tsanet_api\",\"token\":\"${{ steps.tsanet.outputs.jwt }}\",\"allowed_domain\":\"connect2.tsanet.net\"}")
          if [ "$HTTP_STATUS" != "201" ]; then
            echo "Failed to create connection: $HTTP_STATUS"
            exit 1
          fi
          echo "Fresh bearer token connection installed"

  # ── Job 2: SLA Breach Monitor ────────────────────────────────────────────────
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

---

## Step 7 — Push and Verify

```bash
git add .github/workflows/tsanet-maintenance.yml
git commit -m "Add TSANet Maintenance workflow (token refresh + SLA monitor)"
git push
```

> If the push is rejected with a `workflow` scope error, run: `gh auth refresh -s workflow`

Then verify:
1. Go to your repo → **Actions** tab
2. Find **TSANet Maintenance** → click **Run workflow** to trigger manually
3. Both jobs should complete green within ~30 seconds
4. Confirm the ZIS bearer connection is active by calling the ZIS API directly:
   ```bash
   curl -s -u "YOUR_EMAIL/token:YOUR_API_TOKEN" \
     "https://YOURSUBDOMAIN.zendesk.com/api/services/zis/integrations/tsanet_connect/connections"
   ```
   You should see a `tsanet_api` bearer connection in the response (Option B) or the `tsanet_oauth` connection (Option A). Note: ZIS custom integrations do **not** appear in Admin Center UI (Apps and integrations → Integrations) — that page only shows marketplace integrations. The API is the only way to verify.

---

## Step 8 — Create the SLA Breach Trigger in Zendesk

If you haven't done this as part of the ZAF setup:

1. Go to **Admin Center → Objects and rules → Business rules → Triggers**
2. Create a trigger named `TSANet SLA Breach — Notify Assignee`
3. Conditions:
   - `Update type` | `is` | `Changed`
   - `Current tags` | `includes` | `tsanet_sla_breached`
4. Action: `Notify user` → `(Assignee)` with appropriate subject and body
5. Save

This fires exactly once per breach (the tag is only added once — subsequent runs skip already-tagged tickets).

---

## How It All Fits Together

```
TSANet API                    Zendesk
──────────────────────────    ─────────────────────────────────────
Option A:
Entra tokens (~60 min)   ←── ZIS OAuth connection "tsanet_oauth"
                              mints and renews tokens itself —
                              nothing scheduled, no refresh job

Option B:
JWT (expires ~60 min)    ←── GitHub Actions refresh-token job
                              (runs at :00 and :50 every hour)
                              Registers fresh JWT as ZIS bearer
                              connection named "tsanet_api"

Both options:
OPEN cases list          ←── GitHub Actions sla-monitor job
                              (runs at :00 and :50 every hour)
                              Finds overdue cases → tags tickets
                              → Zendesk trigger → email to assignee
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `refresh-token` job fails at "Get ZIS OAuth token" | Verify `ZIS_CLIENT_ID` secret matches the OAuth client ID in Admin Center |
| `refresh-token` job fails at "Install fresh ZIS connection" with 409 | The DELETE step likely returned an unexpected status — check logs for HTTP code |
| `sla-monitor` job finds no tickets for breached cases | Check that `ZENDESK_FIELD_ID_TOKEN` matches the TSANet Token field ID used by the ZAF app |
| Trigger fires repeatedly for same ticket | Confirm the trigger condition uses `current_tags` (not `tags`) — wrong field name causes the check to fail silently |
| `gh auth refresh -s workflow` required | GitHub OAuth token was issued without the `workflow` scope — this is a one-time fix |
| ZIS connection shows as `allowed_domain: connect2.tsanet.net` but using production | Update the workflow and re-run — the connection `allowed_domain` must match the API host |
| Option A: ZIS reports `AADSTS7000215` (invalid client secret) but the same secret works elsewhere | The stored value is corrupted (paste artifact, trimmed leading punctuation) — re-send it verbatim via `PATCH /api/services/zis/connections/oauth/clients/tsanet_connect/{uuid}` |
| Option A: updating the OAuth client returns 405 | Use `PATCH`, not `PUT`, on the client endpoint |
| Option A: connection created but no `access_token` | The `verification_code` exchange step was skipped — GET the `redirect_url` from the start response with the ZIS bearer |

---

## Key Concepts

**Why refresh the ZIS token?**  
TSANet JWTs expire in ~60 minutes. ZIS stores the connection credentials internally, so each ZIS flow that calls the TSANet API gets a valid token automatically — without any ZIS flow needing to handle authentication logic itself.

**Why GitHub Actions and not ZIS flows?**  
ZIS flows are event-driven (triggered by Zendesk events like ticket updates). Neither the token refresh nor the SLA poll fits that model — both need to run on a time schedule regardless of ticket activity. GitHub Actions scheduled workflows are the simplest and most reliable mechanism for this.

**Why is the SLA scope only OPEN cases?**  
TSANet SLA is acknowledgment-only. Once a case is Accepted, Rejected, or Info Requested (`responded: true`), TSANet stops tracking it. Checking ACCEPTED/CLOSED cases for SLA breaches would produce false positives.

---

## Important Limitations

**ZIS scheduled polling is retired**  
An earlier design included a ZIS flow (`flow_poll_tsanet`) intended to poll TSANet for inbound cases on a schedule. This never functioned due to three layered failures (clock ticket required `new` status, no `requestToken` in automation payload, JWT expiry during execution). The flow remains installed but is permanently dormant — both Zendesk automations that triggered it have been disabled. Inbound case sync is now handled entirely by:
- **ZAF background poller** — runs every 5 minutes while any agent has Zendesk open
- **GitHub Actions `sla-monitor`** — server-side SLA breach detection regardless of browser state

**ZIS inbound webhook is blocked**  
TSANet's webhook notifications are sent without an `Authorization` header, which ZIS requires for inbound webhook flows. Until TSANet adds configurable webhook authentication, ZIS cannot receive push notifications from TSANet. The ZAF background poller covers this gap via polling. A `callbackAuth` capability on webhook registration is planned to resolve this — tracked in [issue #2](https://github.com/tsanetgit/Zendesk/issues/2).

**Zendesk Views API cannot set custom field columns**  
If you create or modify a Zendesk view via the API and include `custom_field_XXXXXXX` column IDs in `execution.columns`, the API accepts the request without error but silently reverts to the original columns. Custom field columns on views must be configured manually in **Admin Center → Workspaces → Views**.
