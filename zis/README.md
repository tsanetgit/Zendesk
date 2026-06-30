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
  → ZIS inbound webhook (Basic auth)            … via callbackAuth (issue #2, in API v3.1.0)
  → jobspec_handle_ping → flow_handle_ping
      GetCollaboration   pull full case from TSANet API   (OAuth connection "tsanet_oauth")
      SearchTicket       find ticket by TSANet Token field (connection "zendesk")
      CheckTicketExists  branch on whether the ticket already exists
      ├─ exists   → TransformForUpdate → UpdateTicket
      │              jq: status → lowercase option value, respondBy → YYYY-MM-DD
      └─ no match → GuardCreate                                   (idempotency guard, issue #42)
                     ├─ eventType note.created → NoOp        skip; a note can't be the first event
                     └─ else                   → CreateTicket  new ticket w/ token/status/partner
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
| Field-driven field IDs | `flow_field_action` `GuardField`, `action_zd_finish_status` / `_silent` / `_fail`, and the `Extract` jq | Placeholders for the two field-driven fields: **TSANet Action** dropdown (`1234567891`) and **TSANet Action Text** (`1234567895`). Replace both with **your** instance's field IDs — see *Field-driven case actions* below |
| API host | **all five** TSANet API actions — `action_get_collaboration`, `action_ts_accept`, `action_ts_reject`, `action_ts_info`, `action_ts_note` | File ships with Production (`connect2.tsanet.org`); use `connect2.tsanet.net` for Beta. The host appears in every action that calls the TSANet API, not just `action_get_collaboration` — substitute all five or the lifecycle actions will hit the wrong environment |
| `engineerEmail` | `action_ts_accept` | Replace `YOUR_TSANET_API_EMAIL` with your TSANet API user email. It **must** be on your member-registered domain — TSANet's Accept endpoint rejects emails from any other domain. See *Field-driven case actions* below |
| OAuth connection name | **all five** TSANet API actions (the same five as API host) | File ships with `tsanet_oauth`. If your instance named its OAuth connection differently (e.g. `tsanet_beta_oauth`), substitute it in **all five** actions, or every TSANet call fails auth against a nonexistent connection. Symptom: ingest accepts (HTTP 200) but the flow's `action_ts_*` silently no-op via their `Catch`. Verify the live name with `GET /api/services/zis/connections/{integration}?name=<name>` |

Connection name `zendesk` (basic-auth, Zendesk-side actions) matches the Quick Start. The OAuth connection name is per-instance — see the row above.

> Validated end-to-end on Beta (`connect2.tsanet.net`): authenticated webhook deliveries return 200 and the flow creates Zendesk tickets. The per-instance set is field IDs, host, `engineerEmail`, **and the OAuth connection name** — nothing else is environment-specific.

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

The webhook subscription on the TSANet side uses the `callbackAuth` capability (issue #2), delivered in API **v3.1.0**: register with `callbackUrl` = the ingest URL and `callbackAuth` of type `BASIC` carrying the ingest credentials. TSANet attaches them to every delivery POST alongside the existing `X-Hub-Signature-256` HMAC, and the ZIS ingest accepts the authenticated request (validated on Beta: deliveries return 200 and create tickets). The pipeline can also be exercised without a live subscription by POSTing a `WebhookPayload`-shaped body (`eventType`, `requestToken`, `timestamp`) to the ingest URL with the Basic credentials.

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

## Inbound comment forwarding — public reply → partner note (issue #34)

When an agent posts a **public reply** on a TSANet ticket, it is forwarded to the partner as a TSANet note, so the partner sees agent replies without anyone re-typing them. **Internal** comments are never forwarded — only public content reaches the partner.

```
Agent posts a PUBLIC reply on a TSANet ticket (inbound or outbound)
  → Zendesk trigger  (comment is public  AND  tag tsanet_inbound OR tsanet_outbound)
  → Zendesk webhook  (Basic auth)
  → ZIS inbound webhook   (source_system "zendesk", event_type "public_comment")
  → jobspec_forward_comment → flow_forward_comment
        GuardToken → GuardComment → GuardAuthor (agent/admin only)
        ForwardNote → action_ts_note → POST /notes   (connection tsanet_oauth)
```

The flow **reuses `action_ts_note`** (no new action). Loop-safe: the note mirror writes *internal* comments, which never re-fire this *public*-comment trigger.

- **Fail-closed author guard.** `flow_forward_comment` only forwards when `author_role` is `Agent`/`Admin` (the trigger sends `{{current_user.role}}`). An **End-user** public reply never forwards. **Gotcha:** `{{current_user.role}}` renders the literal **`Admin`** (not `Administrator`) — the guard matches `Agent`/`Admin` plus lowercase variants. ZIS `Choice` states only support `StringEquals` (not `StringMatches`), so each accepted value is listed explicitly.
- **Single-path rule (issue #38).** The ZAF app's public **Add Note** posts only the public comment and lets this trigger deliver it. It must **not** also `POST /notes` itself, or the partner gets the note twice.
- **Trigger scope.** It fires on `tsanet_inbound` **or** `tsanet_outbound` so public replies forward on both inbound and outbound cases.

### Setup (in addition to the inbound `collaboration_event` webhook in Deploy above)

```bash
# 1. Create the comment-forwarding inbound webhook (returns its own ingest path + Basic creds — keep them)
curl -X POST "https://YOURSUBDOMAIN.zendesk.com/api/services/zis/inbound_webhooks/generic/tsanet_connect" \
  -H "Authorization: Bearer ZIS_OAUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{"source_system":"zendesk","event_type":"public_comment"}'

# 2. Install its job spec (reinstall after EVERY bundle upload, like the others)
curl -X POST "https://YOURSUBDOMAIN.zendesk.com/api/services/zis/registry/job_specs/install?job_spec_name=zis:tsanet_connect:job_spec:jobspec_forward_comment" \
  -H "Authorization: Bearer ZIS_OAUTH_TOKEN"
```

Then, in **Zendesk Admin** (or via `/api/v2/webhooks` + `/api/v2/triggers`):
- A **webhook** with **Basic auth** = the step-1 ingest credentials, endpoint = the step-1 ingest URL, JSON.
- A **trigger** — conditions: *comment is public* AND (current tags include `tsanet_inbound` **or** `tsanet_outbound`); action: notify that webhook with body `{"token":"{{ticket.ticket_field_<TOKEN_FIELD_ID>}}","comment":"{{ticket.latest_public_comment}}","ticket_id":"{{ticket.id}}","author_role":"{{current_user.role}}"}`.

> Updating an existing trigger via the API **replaces** it — include the existing `actions` in the `PUT`, or you get `422 "Trigger must contain at least one action"`.

## Gotchas (each cost real debugging time — full record in issue #18)

- **Reinstall job specs after every bundle upload.** Uploads orphan existing installs; the flow silently stops firing.
- **Stale installed job specs keep running.** Job specs from older bundle generations stay installed even when no longer defined in the bundle, and will intercept events. List with `GET /api/services/zis/registry/tsanet_connect/job_specs`; uninstall with `DELETE .../job_specs/install?job_spec_name=...`.
- **Zendesk-side actions need the `zendesk` connection.** Path-only actions return `401 Couldn't authenticate you`. Use a basic-auth connection (API token) rather than a bearer connection — bearer tokens go stale.
- **Connection names are unique across types**, and `GET /api/services/zis/connections/{integration}?name=` only returns OAuth connections. If a create returns 409 but the typed GET 404s, check the other legacy types (`bearer_token`, `basic_auth`).
- **Request bodies are mustache-templated** (`{{$.x}}`). JSONPath-style keys (`"value.$": "$.x"`) inside `requestBody` fail with `Error Resolving JSON Params`.
- **Zendesk date fields reject ISO datetimes** (422 `InvalidValue`). The flow's Jq transform truncates `respondBy` to `YYYY-MM-DD`; keep that state if you modify the flow.
- **The Integration Log is the only debugging surface** (Admin Center → Apps and integrations → Integrations → Integration logs; there is no API). Each entry's `execution_states` + `details` pinpoints the failing state.
- **Zendesk search is eventually consistent.** `SearchTicket` can miss a ticket created seconds earlier. The common redelivery race (a `note.created` arriving before the just-created ticket is searchable) is handled by `GuardCreate`, which no-ops `note.created` events that find no ticket instead of creating a second one (issue #42). Other rapid-fire test pings can still in theory duplicate; real usage is safe because events for one case arrive minutes apart.

## Reference (generated)

<!-- BEGIN GENERATED: bundle reference (do not edit by hand; run zis/gen_readme_reference.py) -->
> Generated from `tsanet_connect_bundle.json` by `zis/gen_readme_reference.py`.
> Do not edit between the markers; run the script to refresh.

Bundle `tsanet_connect` · template `2019-10-14` · 12 actions, 3 flows, 3 job specs.

### Job specs (event → flow)

| Job spec | event_source | event_type | Flow |
|---|---|---|---|
| `jobspec_field_action` | `support` | `ticket.CustomFieldChanged` | `flow_field_action` |
| `jobspec_forward_comment` | `zendesk` | `public_comment` | `flow_forward_comment` |
| `jobspec_handle_ping` | `tsanet` | `collaboration_event` | `flow_handle_ping` |

### Actions

| Action | Connection | Method | Endpoint |
|---|---|---|---|
| `action_create_ticket` | `zendesk` | POST | `/api/v2/tickets.json` |
| `action_get_collaboration` | `tsanet_oauth` | GET | `https://connect2.tsanet.org/v1/collaboration-requests/{requestToken}` |
| `action_search_ticket` | `zendesk` | GET | `/api/v2/tickets.json?external_id={requestToken}` |
| `action_ts_accept` | `tsanet_oauth` | POST | `https://connect2.tsanet.org/v1/collaboration-requests/{token}/approval` |
| `action_ts_info` | `tsanet_oauth` | POST | `https://connect2.tsanet.org/v1/collaboration-requests/{token}/information-request` |
| `action_ts_note` | `tsanet_oauth` | POST | `https://connect2.tsanet.org/v1/collaboration-requests/{token}/notes` |
| `action_ts_reject` | `tsanet_oauth` | POST | `https://connect2.tsanet.org/v1/collaboration-requests/{token}/rejection` |
| `action_update_ticket` | `zendesk` | PUT | `/api/v2/tickets/{ticket_id}.json` |
| `action_zd_finish_fail` | `zendesk` | PUT | `/api/v2/tickets/{ticket_id}.json` |
| `action_zd_finish_silent` | `zendesk` | PUT | `/api/v2/tickets/{ticket_id}.json` |
| `action_zd_finish_status` | `zendesk` | PUT | `/api/v2/tickets/{ticket_id}.json` |
| `action_zd_get_ticket` | `zendesk` | GET | `/api/v2/tickets/{ticket_id}.json` |

### Flows (states)

- **`flow_field_action`** — StartAt `GuardField`
  - `AcceptCase` (Action) → `action_ts_accept`
  - `CheckToken` (Choice)
  - `Dispatch` (Choice)
  - `Extract` (Action) → `Jq`
  - `FailComment` (Action) → `action_zd_finish_fail`
  - `FinishAccept` (Action) → `action_zd_finish_status`
  - `FinishInfo` (Action) → `action_zd_finish_status`
  - `FinishNote` (Action) → `action_zd_finish_silent`
  - `FinishReject` (Action) → `action_zd_finish_status`
  - `GetTicket` (Action) → `action_zd_get_ticket`
  - `GuardField` (Choice)
  - `GuardValue` (Choice)
  - `InfoCase` (Action) → `action_ts_info`
  - `NoOp` (Succeed)
  - `NoteCase` (Action) → `action_ts_note`
  - `RejectCase` (Action) → `action_ts_reject`
- **`flow_forward_comment`** — StartAt `GuardToken`
  - `ForwardNote` (Action) → `action_ts_note`
  - `GuardAuthor` (Choice)
  - `GuardComment` (Choice)
  - `GuardToken` (Choice)
  - `NoOp` (Succeed)
- **`flow_handle_ping`** — StartAt `GetCollaboration`
  - `BuildSubmitter` (Action) → `Jq`
  - `CheckTicketExists` (Choice)
  - `CreateTicket` (Action) → `action_create_ticket`
  - `GetCollaboration` (Action) → `action_get_collaboration`
  - `GuardCreate` (Choice)
  - `NoOp` (Succeed)
  - `SearchTicket` (Action) → `action_search_ticket`
  - `TransformForUpdate` (Action) → `Jq`
  - `UpdateTicket` (Action) → `action_update_ticket`
<!-- END GENERATED: bundle reference -->
