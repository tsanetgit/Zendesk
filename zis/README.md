# TSANet Connect — ZIS Flow Bundle

The ZIS flow bundle for **event-driven inbound** (ping-then-pull): TSANet pings a ZIS inbound webhook, the flow pulls the full collaboration from the TSANet API, and a Zendesk ticket is created (new case) or updated (existing case). No scheduled polling, no token-refresh jobs.

This directory is the **source of truth** for the bundle. The deployed copy in any Zendesk instance should match this file (with the per-instance substitutions below).

```
zis/
├── tsanet_connect_bundle.json   ← the bundle (flows, actions, job spec)
└── README.md                    ← this file
```

## What the flow does

```
TSANet webhook ping (eventType + requestToken)
  → ZIS inbound webhook (Basic auth)            … requires callbackAuth (issue #2)
  → jobspec_handle_ping → flow_handle_ping
      GetCollaboration   pull full case from TSANet API   (OAuth connection "tsanet_oauth")
      SearchTicket       find ticket by TSANet Token field (connection "zendesk")
      CheckTicketExists  branch
      ├─ CreateTicket    new Zendesk ticket with token/status/partner fields
      └─ TransformForUpdate → UpdateTicket
                         jq: status → lowercase option value, respondBy → YYYY-MM-DD
```

## Prerequisites

1. The ZIS integration `tsanet_connect` exists and the **OAuth client-credentials connection** `tsanet_oauth` is configured — see [ZIS_Quick_Start.md](../ZIS_Quick_Start.md) Steps 1–4.
2. A **basic-auth connection named `zendesk`** for the Zendesk-side actions (path-only actions do **not** auto-authenticate):
   ```bash
   curl -X POST \
     "https://YOURSUBDOMAIN.zendesk.com/api/services/zis/integrations/tsanet_connect/connections/basic_auth" \
     -H "Authorization: Bearer ZIS_OAUTH_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"name":"zendesk","username":"YOUR_EMAIL/token","password":"YOUR_API_TOKEN","allowed_domain":"YOURSUBDOMAIN.zendesk.com"}'
   ```

## Per-instance substitutions (edit the JSON before upload)

| What | Where | Note |
|---|---|---|
| Custom field IDs | `action_create_ticket`, `action_search_ticket`, `action_update_ticket` | Replace the three numeric IDs (TSANet Token / Status / Partner, plus Respond By in the update action) with **your** instance's field IDs |
| API host | `action_get_collaboration.url` | File ships with Production (`connect2.tsanet.org`); use `connect2.tsanet.net` for Beta |

Connection names (`tsanet_oauth`, `zendesk`) match the Quick Start and need no change if you followed it.

## Deploy

```bash
# 1. Upload the bundle (basic auth / API token — the ZIS OAuth bearer is NOT accepted here)
curl -X POST "https://YOURSUBDOMAIN.zendesk.com/api/services/zis/registry/tsanet_connect/bundles" \
  -u "YOUR_EMAIL/token:YOUR_API_TOKEN" -H "Content-Type: application/json" \
  -d @tsanet_connect_bundle.json

# 2. Create the inbound webhook (returns ingest path + Basic credentials — keep them)
curl -X POST "https://YOURSUBDOMAIN.zendesk.com/api/services/zis/inbound_webhooks/generic/tsanet_connect" \
  -H "Authorization: Bearer ZIS_OAUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{"source_system":"tsanet","event_type":"collaboration_event"}'

# 3. Install the job spec (ALWAYS re-run after every bundle upload — uploads orphan installs)
curl -X POST "https://YOURSUBDOMAIN.zendesk.com/api/services/zis/registry/job_specs/install?job_spec_name=zis:tsanet_connect:job_spec:jobspec_handle_ping" \
  -H "Authorization: Bearer ZIS_OAUTH_TOKEN"
```

The webhook subscription on the TSANet side (callbackUrl = the ingest URL, with its Basic credentials) requires the `callbackAuth` capability tracked in issue #2. Until then, the pipeline can be exercised by POSTing a `WebhookPayload`-shaped body (`eventType`, `requestToken`, `timestamp`) to the ingest URL with the Basic credentials.

## Field-driven case actions (no ZAF app required)

The bundle also includes `flow_field_action` + `jobspec_field_action` (issue #22): the full inbound lifecycle — Accept, Reject, Request Info, Add Note — driven entirely by native Zendesk controls. An agent (or a macro) sets the **TSANet Action** dropdown; a ZIS flow executes the action against the TSANet API and clears the field. No private app needed.

### Additional setup

1. Create two more custom ticket fields and substitute their IDs in the bundle (alongside the other field IDs):
   - **TSANet Action** — dropdown with options `Accept` (tag `tsanet_action_accept`), `Reject` (`tsanet_action_reject`), `Request Info` (`tsanet_action_request_info`), `Add Note` (`tsanet_action_add_note`)
   - **TSANet Action Text** — text; holds the reject reason / info question / note body
2. Substitute `YOUR_TSANET_API_EMAIL` in `action_ts_accept` with your TSANet API user email (TSANet's Accept endpoint requires an `engineerEmail` from your registered domain — agent emails fail validation).
3. The job spec `jobspec_field_action` subscribes to `support` / `ticket.CustomFieldChanged` — install it like the others (and reinstall after every bundle upload).
4. Optional but recommended: four macros ("TSANet: Accept", ...) that set the Action (and prompt for Action Text where relevant) for one-click agent UX.

### Behavior

- **Success:** internal comment + TSANet Status updated + Action field cleared. Exception: **Add Note succeeds silently** — the note mirror is the receipt (prevents double comments).
- **Failure** (wrong case state, missing text, no token): internal comment explaining, Action cleared, Status untouched. Details land in the Integration Log.
- **Guards:** the flow no-ops unless the changed field is TSANet Action with a non-empty action value — so the flow's own clears, status syncs, and any ZAF field writes never re-trigger it. Safe to run alongside the ZAF app (the two action paths are independent; see issue #22 for the coexistence analysis).

## Gotchas (each cost real debugging time — full record in issue #18)

- **Reinstall job specs after every bundle upload.** Uploads orphan existing installs; the flow silently stops firing.
- **Stale installed job specs keep running.** Job specs from older bundle generations stay installed even when no longer defined in the bundle, and will intercept events. List with `GET /api/services/zis/registry/tsanet_connect/job_specs`; uninstall with `DELETE .../job_specs/install?job_spec_name=...`.
- **Zendesk-side actions need the `zendesk` connection.** Path-only actions return `401 Couldn't authenticate you`. Use a basic-auth connection (API token) rather than a bearer connection — bearer tokens go stale.
- **Connection names are unique across types**, and `GET /api/services/zis/connections/{integration}?name=` only returns OAuth connections. If a create returns 409 but the typed GET 404s, check the other legacy types (`bearer_token`, `basic_auth`).
- **Request bodies are mustache-templated** (`{{$.x}}`). JSONPath-style keys (`"value.$": "$.x"`) inside `requestBody` fail with `Error Resolving JSON Params`.
- **Zendesk date fields reject ISO datetimes** (422 `InvalidValue`). The flow's Jq transform truncates `respondBy` to `YYYY-MM-DD`; keep that state if you modify the flow.
- **The Integration Log is the only debugging surface** (Admin Center → Apps and integrations → Integrations → Integration logs; there is no API). Each entry's `execution_states` + `details` pinpoints the failing state.
- **Zendesk search is eventually consistent** — `SearchTicket` can miss a ticket created seconds earlier. Harmless in real usage (events for the same case arrive minutes apart), but rapid-fire test pings can produce a duplicate.
