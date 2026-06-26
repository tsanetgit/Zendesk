---
name: tsanet-connect
description: Expert implementation guide for TSANet Connect integrations with Zendesk. Covers the ZAF sidebar app, ZIS OAuth client-credentials (Microsoft Entra) auth, inbound push delivery via callbackAuth, the optional GitHub Actions SLA monitor, Zendesk custom fields, and all known API quirks and gotchas discovered through production implementation. (The legacy ZIS bearer-token connection and its GitHub Actions refresh job are retired and retained only for reference.)
trigger: Use when the user is implementing TSANet Connect with Zendesk, building a ZAF (Zendesk Apps Framework) sidebar app for TSANet, setting up ZIS (Zendesk Integration Services) for TSANet, working with the TSANet REST API, configuring GitHub Actions for TSANet token refresh or SLA monitoring, creating Zendesk custom fields for TSANet data, debugging TSANet collaboration case flows, or asks about TSANet Connect, TSANet API, ZAF app, ZIS bearer token, SLA breach detection, or collaboration case lifecycle. Also trigger on "tsanet", "collaboration case", "TSANet token", "respondBy", "ZIS bearer", or "ZAF sidebar" in any implementation context.
---

# TSANet Connect — Zendesk Integration Expert

You are a specialized implementation assistant for TSANet Connect + Zendesk integrations. You have deep knowledge of the TSANet REST API, Zendesk Apps Framework (ZAF), Zendesk Integration Services (ZIS), and all the undocumented quirks, API restrictions, and architectural constraints discovered through a complete production implementation.

When a member asks for implementation help, always:
1. Identify which integration layer they need (ZAF app, ZIS, GitHub Actions, or custom REST)
2. Surface relevant API gotchas before they hit them
3. Recommend the proven patterns from production — don't invent new approaches for solved problems

---

## Architecture Overview

A complete TSANet Connect + Zendesk integration has three layers:

```
┌─────────────────────────────────────────────────────────┐
│  LAYER 1: ZAF Sidebar App (agents use this)             │
│  • sidebar panel on every Zendesk ticket                │
│  • reads/writes TSANet API via ZAF proxy                │
│  • background page polls for inbound cases every 1 min  │
│  • mirrors TSANet notes → Zendesk internal comments     │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│  LAYER 2: ZIS OAuth Connection (Entra)                  │
│  • holds TSANet-issued Entra client credential          │
│  • mints/renews its own short-lived tokens              │
│  • no static token to refresh (retires bearer job)      │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│  LAYER 3: GitHub Actions (server-side, optional)        │
│  • sla-monitor job: tags tickets on SLA breach          │
│  • runs at :00 and :50 every hour, no browser           │
│  • token-refresh job retired (Entra self-renews)        │
└─────────────────────────────────────────────────────────┘
```

**What ZIS flows are NOT used for:**
ZIS scheduled polling (`flow_poll_tsanet`) is architecturally broken — ZIS flows cannot call ZIS management endpoints (circular OAuth scope). What is retired is ZIS-based token *refresh*, replaced by the OAuth client-credentials connection (see ZIS section). ZIS now CAN receive an inbound TSANet push via a generic inbound webhook secured by the `callbackAuth` capability (API v3.1.0); previously this was blocked because TSANet sent no `Authorization` header on webhooks. GitHub Actions remains the server-side scheduler for polling. Do not attempt to rebuild ZIS-based polling or ZIS-based token refresh flows.

---

## TSANet REST API

### Environments
| Environment | Base URL |
|---|---|
| Beta | `https://connect2.tsanet.net/v1` |
| Production | `https://connect2.tsanet.org/v1` |

### Authentication
JWT Bearer. Always call `POST /v1/login` first. Token expires in ~60 minutes.

```javascript
// Login
POST /v1/login
{ "username": "api@yourcompany.com", "password": "yourpassword" }
→ { "accessToken": "eyJ...", "tokenType": "Bearer", "expiresIn": 3600 }

// All subsequent calls
Authorization: Bearer <accessToken>
```

> **Verify identity after login:** always call `GET /v1/me` during development to confirm credentials and capture `companyId`. The `company.domain` field is important — see Accept bug below.

### Authentication — OAuth 2.0 client credentials (Microsoft Entra, live / default)
This is now the **live, default** auth scheme for server-to-server integrations, validated end to end on TSANet's Beta environment (issue #1 closed). Inbound webhook delivery (TSANet -> ZIS) uses the `callbackAuth` capability, delivered in API v3.1.0 and validated on Beta (issue #2 closed).

- Obtain a token from Microsoft Entra via the **client credentials** grant: `POST https://login.microsoftonline.com/{tenant-id}/oauth2/v2.0/token` with `grant_type=client_credentials`, your TSANet-issued `client_id`/`client_secret`, and `scope=api://{audience}/.default` (TSANet provides the audience value). Pass the result as a Bearer token.
- **Service principal provisioning is required.** The API accepts an app-only token only if your service principal's object ID has been provisioned by TSANet; provisioning is also what maps your tokens to your member company. Contact TSANet with your service principal OID to be onboarded.
- The API accepts the default v1-format Entra token (bare-GUID `aud` claim) — no `requestedAccessTokenVersion` change is needed on the client app registration.
- Tokens live ~60 minutes, but unlike the legacy `/v1/login` JWT, the **caller re-mints automatically from the long-lived client credential** — there is no static token to refresh. This is what retires the ZIS bearer-token refresh workaround (see ZIS section).
- Entra client secrets are random strings that can begin with punctuation (a leading `.` has been seen in production). Store and transmit them verbatim; "cleaning" the value breaks authentication with `AADSTS7000215`.

### Key Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/login` | Authenticate, get JWT |
| `GET` | `/v1/me` | Verify identity, get companyId/domain |
| `GET` | `/v1/partners/{searchTerm}` | Find partner companyId/departmentId |
| `GET` | `/v1/partners/search?query=...` | Semantic partner search (natural-language `query`; optional `limit`, default 10) |
| `GET` | `/v1/forms/department/{departmentId}` | Get form template + required `documentId` |
| `GET` | `/v1/forms/company/{companyId}` | Same, by company |
| `POST` | `/v1/collaboration-requests` | Submit new outbound case |
| `GET` | `/v2/collaboration-requests` | List cases — **current**. Paginated: returns `{content:[...]}`. `type`/`status` filters accept `ALL`; also `internalCaseNumber`, `page`, `size` |
| `GET` | `/v2/collaboration-requests/list` | List cases — non-paginated plain array. Also supports `updatedAfter`/`createdAfter` |
| `GET` | `/v1/collaboration-requests` | Legacy list — still returns 200 (plain array). `/v2/` is current; `/v1/` retained for backward compatibility. **There is no `/v1/cases` endpoint** — a common wrong guess that returns 404 |
| `GET` | `/v1/collaboration-requests/{token}` | Full case details including notes |
| `POST` | `/v1/collaboration-requests/{token}/approval` | Accept an inbound case |
| `POST` | `/v1/collaboration-requests/{token}/information-request` | Request more info |
| `POST` | `/v1/collaboration-requests/{token}/information-response` | Respond to info request |
| `POST` | `/v1/collaboration-requests/{token}/rejection` | Reject an inbound case |
| `POST` | `/v1/collaboration-requests/{token}/closure` | Close the case |
| `POST` | `/v1/collaboration-requests/{token}/notes` | Post a note |
| `GET` | `/v1/collaboration-requests/{token}/notes` | Get all notes |

### Case Lifecycle
```
OPEN → INFORMATION → ACCEPTED → CLOSED
                         ↓
                      REJECTED
```
- `responded: false` = OPEN (SLA clock running)
- `responded: true` = case has been Accepted/Rejected/Info Requested (SLA stopped)
- Only the **submitting company** can call `/closure` — attempting it as the receiver returns an error
- `PENDINGACTION` is an additional status returned/filterable by the `/v2/` list endpoints — surfaces cases awaiting an action from your side

### Case Statuses and the `responded` Flag
**Critical:** The TSANet SLA tracks only the **initial acknowledgment** deadline (`respondBy`). Once `responded === true`, TSANet stops tracking SLA. Never show SLA countdowns or run breach detection on cases where `responded === true`. Gate all SLA logic on `responded === false`.

### Polling for Inbound Cases
```javascript
// Incremental poll — store updatedAt of last synced record
GET /v2/collaboration-requests/list?type=INBOUND&updatedAfter=2026-01-01T00:00:00Z
```

### Notes API — Critical Behavior
> For when a note reaches the partner vs. stays internal, see **Inbound Comment Forwarding & Note Visibility** (public/internal model).

- `summary` is **required**, max 500 chars
- `description` is optional, max 5,000 chars
- **IMPORTANT:** The TSANet web UI always renders both `summary` AND `description` as separate labeled sections. If you POST `{ summary: "text", description: "text" }` with identical values, the web UI shows it twice — it looks like duplication but it's intentional rendering.
- **Correct pattern for Add Note UI:** present two separate fields — Subject (→ `summary`) and Details (→ `description`, only included if the user fills it in). Never auto-copy `summary` into `description`.

```javascript
// Correct Add Note POST body
var body = { summary: subject };
if (details && details.trim()) body.description = details;
POST /v1/collaboration-requests/{token}/notes
```

### Notes: HTML in Responses
TSANet returns **note** content (`summary` / `description`) as HTML (e.g. `<p>text</p>`, `<br/>` tags). Strip it to plain text before displaying. (The process form's `adminNote` is the exception — it is authored HTML meant to render, not strip; see **Process Form Rendering** below.)
```javascript
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}
```

### Process Form Rendering — Custom Field Options and `adminNote`
When you render a partner's process form (`GET /v1/forms/company/{id}` or `/forms/department/{id}`), two fields have non-obvious shapes that cost real bugs:

**SELECT custom field `options` are newline-delimited, not comma-delimited.** The `customFields[].options` string separates choices with newlines (CRLF), e.g. `"AHV\r\nESXi\r\nHyper-V\r\nKVM\r\nNA\r\nXenserver"`. The structured `selections[]` array exists in the schema but is frequently empty. Splitting `options` on commas collapses every choice into a single option. Parse in this order: `selections[].value` if present, else split `options` on newlines, else fall back to commas.
```javascript
function parseOptions(f) {
  if (Array.isArray(f.selections) && f.selections.length)
    return f.selections.map(function(s){ return s && s.value != null ? String(s.value).trim() : ''; }).filter(Boolean);
  var raw = f.options || '';
  var p = raw.split(/\r\n|\r|\n/).map(function(o){ return o.trim(); }).filter(Boolean);
  return p.length > 1 ? p : raw.split(',').map(function(o){ return o.trim(); }).filter(Boolean);
}
```

**`adminNote` ("Partner instructions") is authored HTML — sanitize and render, do not strip or escape.** Unlike note descriptions (strip those to text), the form's `adminNote` is HTML the partner authored — formatted text and links — and is meant to render, matching the TSANet web app. Escaping it shows raw tags (`<p>`, `<a href...>`); stripping it loses the links. Sanitize against a tag allowlist and render: allow `p/br/strong/em/b/i/u/ul/ol/li/a/span`, force links to `target="_blank" rel="noopener noreferrer"` with `http(s):`-only hrefs, and drop scripts, event handlers, and styles.
```javascript
function sanitizeHtml(html) {
  if (!html) return '';
  var ALLOWED = { P:1, BR:1, STRONG:1, B:1, EM:1, I:1, U:1, UL:1, OL:1, LI:1, A:1, SPAN:1 };
  var doc = new DOMParser().parseFromString(String(html), 'text/html');
  (function clean(node){
    var c = node.firstChild;
    while (c) {
      var next = c.nextSibling;
      if (c.nodeType === 1) {                 // element
        clean(c);
        if (ALLOWED[c.tagName]) {
          [].slice.call(c.attributes).forEach(function(a){
            var n = a.name.toLowerCase();
            if (c.tagName === 'A' && n === 'href') { if (!/^https?:\/\//i.test(c.getAttribute('href') || '')) c.removeAttribute('href'); }
            else c.removeAttribute(a.name);
          });
          if (c.tagName === 'A') { c.setAttribute('target','_blank'); c.setAttribute('rel','noopener noreferrer'); }
        } else { while (c.firstChild) node.insertBefore(c.firstChild, c); node.removeChild(c); }
      } else if (c.nodeType === 8) {           // comment
        node.removeChild(c);
      }
      c = next;
    }
  })(doc.body);
  return doc.body.innerHTML;
}
```

### Accept Endpoint — Hidden Required Field
The `POST /v1/collaboration-requests/{token}/approval` endpoint has an **undocumented required field**: `engineerEmail`. Omitting it returns "Error processing request" with no helpful message.

Additionally, `engineerEmail` **must be from your company's TSANet-registered domain**. You cannot use a Zendesk agent's personal email — it will fail domain validation. Use your TSANet API username (the dedicated API user email) as the value.

```javascript
POST /v1/collaboration-requests/{token}/approval
{
  "caseNumber": "your-internal-case-number",
  "engineerName": "Support Team",
  "engineerPhone": "+1-800-555-0100",
  "engineerEmail": settings.tsanet_username,  // ← must be TSANet-registered domain
  "nextSteps": "We are investigating. Will update shortly."
}
```

---

## ZAF App Architecture

### What ZAF Is
ZAF (Zendesk Apps Framework) apps run inside cross-origin sandboxed iframes inside Zendesk. This has critical implications:

- **`prompt()` and `confirm()` are silently blocked** in cross-origin iframes. All modals must be custom inline HTML — never use native browser dialogs.
- **All API calls must go through `client.request()`** — the ZAF proxy. Direct `fetch()` or `XMLHttpRequest()` to external domains will be CORS-blocked unless those domains are in `manifest.json` → `domainWhitelist`.
- **No `localStorage`, no `sessionStorage`** — state lives in memory or Zendesk ticket fields.

### Manifest Structure
```json
{
  "name": "Your App Name",
  "id": "your_app_id",
  "version": "1.0.0",
  "frameworkVersion": "2.0",
  "icon": "assets/logo.png",
  "defaultLocale": "en",
  "private": true,
  "location": {
    "support": {
      "ticket_sidebar": {
        "url": "assets/index.html",
        "flexible_height": true
      },
      "background": "assets/background.html"
    }
  },
  "domainWhitelist": [
    "connect2.tsanet.net",
    "connect2.tsanet.org"
  ],
  "parameters": [
    { "name": "tsanet_username", "type": "text", "required": true },
    { "name": "tsanet_password", "type": "text", "required": true },
    { "name": "tsanet_env",      "type": "text", "required": true, "default": "BETA" },
    { "name": "field_id_token",  "type": "text", "required": true }
  ]
}
```

**Required files in the ZIP:**
- `manifest.json`
- `assets/index.html`
- `assets/main.js`
- `assets/background.html` (if using background page)
- `assets/logo.png` (128×128 px transparent PNG — required for app tray icon)
- `translations/en.json` ← **Zendesk rejects the upload without this** even if you have no i18n strings

Minimum `translations/en.json`:
```json
{
  "app": {
    "name": "Your App Name",
    "description": "Short description",
    "short_description": "Short description"
  }
}
```

### ZAF API Calls (Proxy Pattern)
```javascript
// All API calls go through client.request()
// Zendesk proxies them to external domains in domainWhitelist
function tsanetRequest(method, path, body) {
  return getSettings().then(function(settings) {
    return getToken(settings).then(function(jwt) {
      var baseUrl = settings.tsanet_env === 'PRODUCTION'
        ? 'https://connect2.tsanet.org/v1'
        : 'https://connect2.tsanet.net/v1';
      var opts = {
        url: baseUrl + path,
        type: method,
        headers: { 'Authorization': 'Bearer ' + jwt },
        contentType: 'application/json'
      };
      if (body) opts.data = JSON.stringify(body);
      return client.request(opts);
    });
  });
}
```

### Reading Ticket Fields
```javascript
// Reading a custom ticket field value
client.get('ticket.customField:custom_field_' + fieldId)
  .then(function(data) {
    var value = data['ticket.customField:custom_field_' + fieldId];
  });
```

### Writing Ticket Fields
```javascript
// Writing a custom ticket field value
client.set('ticket.customField:custom_field_' + fieldId, value);
```

Note: `client.set()` queues a change in the ZAF form state. It does NOT call the Zendesk API directly. The change is saved when the agent saves the ticket. For guaranteed writes (e.g. writing `respondBy` without agent action), use `client.request()` to call `PUT /api/v2/tickets/{id}.json` directly:
```javascript
client.request({
  url: '/api/v2/tickets/' + ticketId + '.json',
  type: 'PUT',
  contentType: 'application/json',
  data: JSON.stringify({
    ticket: {
      custom_fields: [{ id: fieldIdRespondBy, value: respondBy.substring(0, 10) }]
    }
  })
});
```

> **Date field format:** Zendesk date fields require `YYYY-MM-DD`. ISO datetimes like `2026-05-08T14:00:00Z` are silently rejected. Always truncate with `.substring(0, 10)`.

### Custom Modal Pattern (Required — No prompt()/confirm())
```html
<!-- In index.html -->
<div id="tsanet-modal" style="display:none; background:#fff; border:1px solid #d8dcde; border-radius:4px; padding:12px; margin:8px 0;">
  <div id="modal-msg" style="font-size:12px; margin-bottom:8px;"></div>
  <div id="modal-input1-wrap">
    <div id="modal-input1-label" class="modal-field-label"></div>
    <textarea id="modal-input" rows="2" style="width:100%; box-sizing:border-box;"></textarea>
  </div>
  <div id="modal-input2-wrap" style="display:none;">
    <div id="modal-input2-label" class="modal-field-label"></div>
    <textarea id="modal-input2" rows="4" style="width:100%; box-sizing:border-box;"></textarea>
  </div>
  <div style="text-align:right; margin-top:8px;">
    <button id="modal-cancel">Cancel</button>
    <button id="modal-ok">OK</button>
  </div>
</div>
```

```javascript
var _modalCb = null;

// Single-input prompt
function showPrompt(msg, callback) {
  _modalCb = callback;
  document.getElementById('modal-msg').textContent = msg;
  document.getElementById('modal-input2-wrap').style.display = 'none';
  document.getElementById('modal-input').value = '';
  document.getElementById('tsanet-modal').style.display = 'block';
}

// Two-input prompt (e.g. Add Note: Subject + Details)
function showPrompt2(msg, label1, label2, callback) {
  _modalCb = callback;
  document.getElementById('modal-msg').textContent = msg;
  document.getElementById('modal-input1-label').textContent = label1;
  document.getElementById('modal-input').value = '';
  document.getElementById('modal-input2-label').textContent = label2;
  document.getElementById('modal-input2-wrap').style.display = 'block';
  document.getElementById('modal-input2').value = '';
  document.getElementById('tsanet-modal').style.display = 'block';
}

// Confirm dialog
function showConfirm(msg, callback) {
  _modalCb = function(val) { callback(val !== null); };
  document.getElementById('modal-msg').textContent = msg;
  document.getElementById('modal-input2-wrap').style.display = 'none';
  document.getElementById('modal-input').style.display = 'none';
  document.getElementById('tsanet-modal').style.display = 'block';
}

// OK handler — must handle both 1-field and 2-field cases
document.getElementById('modal-ok').addEventListener('click', function() {
  var input1 = document.getElementById('modal-input').value.trim();
  var input2wrap = document.getElementById('modal-input2-wrap');
  var input2 = input2wrap.style.display !== 'none'
    ? document.getElementById('modal-input2').value.trim()
    : null;
  document.getElementById('tsanet-modal').style.display = 'none';
  if (_modalCb) _modalCb(input1, input2);
});

document.getElementById('modal-cancel').addEventListener('click', function() {
  document.getElementById('tsanet-modal').style.display = 'none';
  if (_modalCb) _modalCb(null);
});
```

### Adaptive Height (Compact Mode for Non-TSANet Tickets)
ZAF apps load at their full configured height on every ticket. To avoid a 500px+ sidebar panel appearing on every regular support ticket:

```javascript
// On ticket load:
// 1. Check if ticket has a TSANet token field value
// 2. If no token → collapse to compact mode (44px bar)
// 3. If token found → expand to full height

var FULL_HEIGHT = 500;   // px
var COMPACT_HEIGHT = 44; // px

function checkToken() {
  client.get('ticket.customField:custom_field_' + fieldIdToken)
    .then(function(data) {
      var token = data['ticket.customField:custom_field_' + fieldIdToken];
      if (token) {
        client.invoke('resize', { width: '100%', height: FULL_HEIGHT + 'px' });
        showFullPanel(token);
      } else {
        client.invoke('resize', { width: '100%', height: COMPACT_HEIGHT + 'px' });
        showCompactBar(); // show "+ New" button only
      }
    });
}
```

### Background Page (Inbound Polling + SLA Monitoring)
The `background.html` page runs continuously while any Zendesk tab is open. Use it for polling — it survives ticket navigation.

```javascript
// background.html — polling loop
var POLL_INTERVAL = 60 * 1000; // 1 minute (JWT is cached ~50 min, so a short interval does not increase login calls; ~60s is the practical floor before TSANet rate-limits)

function pollLoop() {
  checkInboundCases();
  checkSlaBreaches();
  setTimeout(pollLoop, POLL_INTERVAL);
}

ZAFClient.init(function(client) {
  pollLoop();
});
```

### Syncing TSANet Notes → Zendesk Ticket Thread
Agents should be able to see partner notes in the Zendesk ticket thread without opening the ZAF sidebar. Implement note mirroring using `tsanet-note-id:{id}` markers for deduplication:

```javascript
function syncNotesToZendesk(notes, ticketId) {
  if (!notes || !notes.length) return;
  // Fetch existing comments to check what's already been synced
  client.request({
    url: '/api/v2/tickets/' + ticketId + '/comments.json?per_page=100',
    type: 'GET'
  }).then(function(data) {
    var existingBodies = (data.comments || []).map(function(c) {
      return c.plain_body || '';
    });
    // Filter to only notes not yet synced
    var unsyncedNotes = notes.filter(function(note) {
      var marker = 'tsanet-note-id:' + note.id;
      return !existingBodies.some(function(b) { return b.indexOf(marker) !== -1; });
    });
    // Post each missing note sequentially (chained promises — avoids race conditions)
    unsyncedNotes.reduce(function(chain, note) {
      return chain.then(function() {
        var d = new Date(note.createdAt);
        var dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
        var summary = stripHtml(note.summary || '');
        var description = note.description ? stripHtml(note.description) : '';
        var body = '[TSANet Note] ' + (note.companyName || 'Partner') + ' — ' + dateStr
          + '\n\n' + summary;
        if (description && description !== summary) body += '\n\n' + description;
        body += '\n\ntsanet-note-id:' + note.id; // dedup marker — never remove this
        return client.request({
          url: '/api/v2/tickets/' + ticketId + '.json',
          type: 'PUT',
          contentType: 'application/json',
          data: JSON.stringify({ ticket: { comment: { body: body, public: false } } })
        }).catch(function(e) {
          console.warn('[TSANet] Note sync failed for note', note.id, e.message);
          // best-effort — silently continue
        });
      });
    }, Promise.resolve());
  }).catch(function() {});
}
```

Call `syncNotesToZendesk(notes, ticketId)` every time you load the notes list for a ticket.

## Inbound Comment Forwarding & Note Visibility (issues #34, #36, #38)

**Rule: only public content reaches the partner; internal notes stay in Zendesk.**

### Forwarding a public reply to the partner
When an agent posts a **public reply** on a TSANet ticket, a Zendesk trigger forwards it to the partner as a TSANet note. Internal comments are never forwarded.

```
Agent PUBLIC reply on a TSANet ticket (inbound or outbound)
  -> Zendesk trigger (comment is public AND tag tsanet_inbound OR tsanet_outbound)
  -> Zendesk webhook (Basic auth)
  -> ZIS inbound webhook (source_system "zendesk", event_type "public_comment")
  -> jobspec_forward_comment -> flow_forward_comment
        GuardToken -> GuardComment -> GuardAuthor (agent/admin only)
        ForwardNote -> action_ts_note -> POST /collaboration-requests/{token}/notes
```

- **Fail-closed author guard.** The flow forwards only when `author_role` (sent by the trigger as `{{current_user.role}}`) is `Agent`/`Admin`. An **End-user** public reply never forwards. **Gotcha:** `{{current_user.role}}` renders the literal **`Admin`** (not `Administrator`); ZIS `Choice` supports only `StringEquals`, so list each accepted value explicitly (`Agent`, `Admin`, plus lowercase variants).
- **Loop-safe.** The note mirror writes *internal* comments, which never re-fire this *public*-comment trigger.

### Add Note: public vs internal (ZAF)
The ZAF **Add Note** dialog has a **Public / Internal** toggle:
- **Internal** (default) -> an internal Zendesk comment only. **Never** POSTed to TSANet.
- **Public** -> posts **only** a public Zendesk comment; the forwarding trigger above delivers it to the partner.

**Single-path rule (issue #38):** a public Add Note must **not** also `POST /notes` itself — doing both makes the partner receive the note twice (the explicit POST plus the trigger re-forwarding the public comment). Post the public comment and let the trigger forward it.

### Echo suppression in the note mirror
`syncNotesToZendesk` mirrors partner notes into Zendesk as internal comments. It **skips** a note that is *self-authored* (`companyName` === your member company) **and** matches an existing public comment — so a forwarded public reply doesn't bounce back as a redundant internal `[TSANet Note]`. Partner notes are never suppressed, even on a text collision.

### SLA Countdown Display
```javascript
function slaDisplay(respondBy) {
  // Only show on OPEN cases (responded === false)
  var now = Date.now();
  var deadline = new Date(respondBy).getTime();
  var remaining = deadline - now;
  if (remaining <= 0) return '<span style="color:#c00; font-weight:bold;">⚠ BREACHED</span>';
  var hours = Math.floor(remaining / 3600000);
  var mins  = Math.floor((remaining % 3600000) / 60000);
  var color = remaining > 3600000 ? '#2b7' : remaining > 1800000 ? '#f90' : '#c00';
  return '<span style="color:' + color + '; font-weight:bold;">'
    + (hours ? hours + 'h ' : '') + mins + 'm remaining</span>';
}
```

### Deploying a ZAF App
The Zendesk apps API (`PUT /api/v2/apps/{id}.json`) is broken — it returns a Ruby "no implicit conversion of nil into String" error. **Always deliver a ZIP and have the user upload manually:**

1. Admin Center → Apps and Integrations → Zendesk Support Apps
2. Click the app → **Update** → upload ZIP
3. Settings (credentials, field IDs) are preserved across updates

**Build the ZIP:**
```bash
cd /path/to/your/app
zip -r your-app-v1.0.0.zip manifest.json assets/ translations/ -x "*.DS_Store"
```

---

## ZIS Bearer Token Setup

> **LEGACY — retired, retained for reference only.** This static-bearer method (and the GitHub Actions refresh job that kept it alive) was the workaround for the TSANet JWT's 60-minute expiry. It has been replaced by the ZIS **OAuth client-credentials (Microsoft Entra) connection** that mints and renews Entra tokens itself — validated end to end on Beta, with [issue #1](https://github.com/tsanetgit/Zendesk_App/issues/1) closed. Use the OAuth client-credentials connection (documented under **ZIS OAuth Client-Credentials Connection** below) for all new work; do not build the bearer-token connection or its refresh job for a new installation.

ZIS needs to store the live TSANet JWT so that ZIS flows can call the TSANet API. This requires three one-time setup steps:

### Step 1 — Create a ZIS Integration (once per Zendesk subdomain)
```bash
curl -X POST \
  "https://SUBDOMAIN.zendesk.com/api/services/zis/registry/tsanet_connect" \
  -u "EMAIL/token:API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"description":"TSANet Connect"}'
```
The integration name goes in the URL path under `/registry/` (the ZIS Registry API create-integration endpoint), not the request body. 409 Conflict = already exists, proceed.

### Step 2 — Create a ZIS OAuth Client (in Admin Center)
Admin Center → Apps and integrations → APIs → OAuth clients → Add OAuth client.
- Name: `tsanet_zis_client`
- Copy the Client ID — needed for token refresh job

### Step 3 — Install GitHub Actions Workflow
See GitHub Actions section below.

### Verifying the ZIS Connection
ZIS custom integrations **do not appear in Admin Center UI**. Verify via API:
```bash
curl -s -u "EMAIL/token:API_TOKEN" \
  "https://SUBDOMAIN.zendesk.com/api/services/zis/integrations/tsanet_connect/connections"
```
Note: ZIS management endpoints (`/api/services/zis/`) **always return 404 with a standard API token**. They require a ZIS OAuth token (obtained via the OAuth2 flow with your ZIS OAuth client). This is by design — it's not an error.

---

## ZIS OAuth Client-Credentials Connection (Entra — successor to the bearer pattern)

Once TSANet has provisioned your service principal (see the Entra authentication section), ZIS can hold the long-lived client credential and mint/renew the short-lived Entra tokens itself. No GitHub Actions refresh job, no static bearer connection. Validated end to end on TSANet's Beta environment (issue #1 closed).

### Step 1 — Register the OAuth client (scope goes in `default_scopes`)
```bash
curl -X POST \
  "https://SUBDOMAIN.zendesk.com/api/services/zis/connections/oauth/clients/tsanet_connect" \
  -H "Authorization: Bearer ZIS_OAUTH_TOKEN" \
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

### Step 2 — Create the connection (no browser / admin-consent step)
```bash
curl -X POST \
  "https://SUBDOMAIN.zendesk.com/api/services/zis/connections/oauth/start/tsanet_connect" \
  -H "Authorization: Bearer ZIS_OAUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"oauth_client_name": "tsanet_entra", "name": "tsanet_oauth"}'
```
The response contains a `redirect_url` with a `verification_code`. **GET that `access_codes` URL (with the ZIS bearer) to complete creation — this step is required even for client_credentials.** The connection then holds a live `access_token` and `token_expiry`; ZIS renews expired tokens automatically by re-running the client-credentials flow.

### Gotchas (each cost real debugging time)
- **Updating a registered OAuth client is `PATCH`** `/connections/oauth/clients/{integration}/{uuid}` — `PUT` returns 405.
- **The documented force-refresh endpoint** (`POST /api/services/zis/connections/refresh/{integration}?name=...`) **returns 405** — renewal appears to be use-triggered only.
- **`AADSTS7000215` (invalid client secret) through ZIS while the same secret works directly** means the stored value is corrupted — re-PATCH the client with the verbatim secret. Watch for editor/paste artifacts (merged lines, trimmed leading punctuation).
- Show the connection with `GET /api/services/zis/connections/{integration}?name=...` to inspect `token_expiry` and confirm minting worked.
- **The connection NAME is per-instance.** Substitute your instance's connection name in **all five** TSANet API actions (`action_ts_*`) when deploying the bundle. An incomplete substitution makes ingest still return 200 while the `action_ts_*` calls silently no-op — nothing reaches TSANet.

---

## GitHub Actions — TSANet Maintenance Workflow

Two jobs in one workflow file. Run at :00 and :50 every hour.

### Required Repository Secrets
| Secret | Value |
|---|---|
| `TSANET_USERNAME` | TSANet API user email |
| `TSANET_PASSWORD` | TSANet API user password |
| `ZENDESK_SUBDOMAIN` | e.g. `yourcompany` (no `.zendesk.com`) |
| `ZENDESK_EMAIL` | Zendesk admin email for API auth |
| `ZENDESK_API_TOKEN` | Zendesk API token |
| `ZIS_CLIENT_ID` | ZIS OAuth client ID from Admin Center |
| `ZENDESK_FIELD_ID_TOKEN` | Field ID of the TSANet Token custom field |

### Job 1: refresh-token
> **Legacy:** this job is only needed for the static-bearer method. It is not used with the OAuth client-credentials (Entra) ZIS connection, which renews its own tokens.

1. `POST /v1/login` → get fresh TSANet JWT
2. `POST /oauth/tokens` (Zendesk) → get ZIS OAuth token using ZIS Client ID
3. `DELETE` old ZIS bearer connection `tsanet_api` (204 or 404 = both OK)
4. `POST` new ZIS bearer connection with fresh JWT

### Job 2: sla-monitor
1. `POST /v1/login` → get fresh TSANet JWT
2. `GET /v1/collaboration-requests?status=OPEN` → find all open cases (legacy path, still returns 200; `/v2/collaboration-requests?status=OPEN` is the current equivalent)
3. For each case where `respondBy` is in the past:
   - Search Zendesk for ticket by TSANet token field value
   - Check if ticket already has `tsanet_sla_breached` tag (skip if so — prevents duplicate triggers)
   - `POST /api/v2/tickets/{id}/tags.json` with `{"tags":["tsanet_sla_breached"]}`
   - Zendesk trigger fires → emails ticket assignee

> **Tag POST is additive** — `POST /api/v2/tickets/{id}/tags.json` preserves existing tags. It doesn't replace them. This is what you want.

### Push scope issue
If `git push` with the workflow file is rejected:
```bash
gh auth refresh -s workflow
```

---

## Zendesk Custom Fields

Create these in Admin Center → Objects and rules → Tickets → Fields:

| Field Label | Type | Notes |
|---|---|---|
| TSANet Token | Text | Primary key — single token per ticket |
| TSANet Tokens Multi | Text | Optional — multi-token reference store |
| TSANet Status | Dropdown | Values: `tsanet_status_open`, `tsanet_status_accepted`, `tsanet_status_information`, `tsanet_status_rejected`, `tsanet_status_closed` |
| TSANet Partner | Text | Stores partner company name |
| TSANet Respond By | **Date** | YYYY-MM-DD format only |

After creating each field, note the **Field ID** from the URL (e.g. `1234567890`). These are passed as ZAF app settings.

### Zendesk Views
Create a view for agents to monitor active TSANet cases without opening individual tickets.

**View conditions:**
- TSANet Status | is not | Closed
- TSANet Status | is not | (empty)

**Column limitation:** The Zendesk Views API (`PUT /api/v2/views/{id}.json`) silently ignores custom field columns in `execution.columns`. Custom field columns **must be added manually** in Admin Center → Workspaces → Views after the view is created.

### SLA Breach Trigger
Create in Admin Center → Objects and rules → Business rules → Triggers:

- **Name:** `TSANet SLA Breach — Notify Assignee`
- **Conditions:** `Current tags` | `includes` | `tsanet_sla_breached` AND `Update type` | `is` | `Changed`
- **Action:** Notify user → (Assignee)

> Use `current_tags` (not `tags`) in trigger conditions — wrong field name causes silent failure.

---

## Known Bugs and Proven Fixes

| Symptom | Root Cause | Fix |
|---|---|---|
| Action buttons 2–4 do nothing silently | `prompt()`/`confirm()` blocked in cross-origin iframes | Replace with custom inline modal HTML |
| Accept returns "Error processing request" | `engineerEmail` required but undocumented | Include `engineerEmail` in approval POST body |
| Accept fails with domain validation error | Agent's Zendesk email ≠ TSANet company domain | Use `settings.tsanet_username` as `engineerEmail` |
| Notes show raw HTML tags | TSANet returns HTML-formatted note `summary`/`description` | Add `stripHtml()` helper; apply before display |
| Picklist (SELECT) field shows all choices as one combined option | `options` string is newline-delimited (CRLF), not comma; `selections[]` often empty | Split `options` on `\r\n`/`\n` (fall back to commas); prefer `selections[].value` |
| Form "Partner instructions" (`adminNote`) shows raw HTML tags | `adminNote` is authored HTML but was escaped/stripped before display | Sanitize against a tag allowlist and render (links → new tab); do not escape or strip it |
| Add Note causes duplication in TSANet web app | TSANet renders both `summary` and `description` as separate labeled sections | Use two-field modal (Subject/Details); only send `description` if user fills it |
| Close button fails on inbound cases | TSANet only allows the submitting company to close | Show Close button only for outbound (`direction === 'OUTBOUND'`) cases |
| Respond By field not updating in Zendesk | Zendesk Date fields silently reject ISO datetimes | Truncate TSANet `respondBy` to `YYYY-MM-DD` with `.substring(0, 10)` |
| SLA shown on ACCEPTED cases | TSANet SLA is acknowledgment-only | Gate all SLA display and breach detection on `responded === false` |
| ZIS polling automation triggers "no requestToken" | ZIS flow requires `requestToken` but automation payload has none | ZIS polling is not viable; retire `flow_poll_tsanet`, use ZAF poller + GitHub Actions |
| ZIS Admin Center shows no `tsanet_connect` integration | ZIS custom integrations are API-only; don't appear in Admin Center UI | Verify via `GET /api/services/zis/integrations/tsanet_connect/connections` API call |
| App upload fails with "Missing translation file for locale 'en'" | `translations/en.json` absent from ZIP | Add `translations/en.json` with minimum app name/description JSON |
| App icon missing from Zendesk apps tray | No `icon` field in manifest + no logo file | Add `"icon": "assets/logo.png"` to manifest; include 128×128 transparent PNG |
| App loads at full height on every ticket | No height check on load | Implement adaptive height: check token field on load; collapse to 44px if empty |
| `pillow`/PIL import errors on macOS Python 3.14+ | Homebrew pip3 installs to Python 3.9 site-packages | Use Node `sharp` for image generation instead |

---

## Zendesk API Gotchas

- **Trigger field names:** use `current_tags` (not `tags`) for tag conditions; `assignee_id` (not `assignee`) for recipient. Wrong values return "Invalid rule target."
- **Tag POST is additive:** `POST /api/v2/tickets/{id}/tags.json` adds to existing tags. Use this — don't PUT (which replaces).
- **Ticket comments via PUT:** to post an internal comment programmatically: `PUT /api/v2/tickets/{id}.json` with `ticket.comment.public: false`. Do not use the Comments endpoint — it doesn't support the internal flag the same way.
- **Views API custom columns:** silently ignored for custom fields. Manual configuration required.
- **ZIS management endpoints:** always return 404 with standard API tokens. Require ZIS OAuth scope. This is expected behavior, not a bug.

---

## TSANet API Gotchas

- **`documentId` is required on case submission** — get it fresh from the form endpoint every time. Do not cache long-term; vendors update their forms.
- **Partner search returns an array** — a company with multiple departments returns multiple results. Use `departmentId` for precise routing when available.
- **Test submissions:** set `testSubmission: true` on POST to submit without creating real SLA timers or notifications.
- **`token` is the primary key** — save it immediately on case creation. The numeric `id` field exists but `token` is used in all API paths.
- **Incremental poll pattern:** store `updatedAt` of the last synced record; pass as `updatedAfter` on next poll. This matches the Salesforce connector's 15-minute sync pattern.
- **SELECT field `options` are newline-delimited** — the process-form `customFields[].options` string separates choices with `\r\n`, not commas, and `selections[]` is often empty. Split on newlines. See *Process Form Rendering*.
- **`adminNote` is HTML to render, not strip** — the form's admin note ("Partner instructions") is authored HTML (links); sanitize and render it. Only note `summary`/`description` should be stripped to plain text.

---

## Quick Implementation Checklist

**For a new member implementing ZAF + ZIS:**

- [ ] Get TSANet API credentials from membership@tsanet.org
- [ ] Create 5 Zendesk custom fields (Token, Tokens Multi, Status, Partner, Respond By)
- [ ] Note all Field IDs
- [ ] Create ZIS OAuth client in Admin Center
- [ ] Create `tsanet_connect` ZIS integration via API
- [ ] Build ZAF app (use custom modal — no `prompt()`/`confirm()`)
- [ ] Test Accept with `engineerEmail` = `tsanet_username`
- [ ] Verify note add uses Subject+Details two-field pattern
- [ ] Implement note mirroring (`syncNotesToZendesk`) with `tsanet-note-id:` dedup marker
- [ ] Add `translations/en.json` to ZIP (Zendesk rejects without it)
- [ ] Add 128×128 `logo.png` + `"icon"` to manifest
- [ ] Implement adaptive height (collapse on non-TSANet tickets)
- [ ] Deploy via Admin Center manual upload (API upload is broken)
- [ ] Push GitHub Actions `tsanet-maintenance.yml` (with `workflow` scope)
- [ ] Set all 7 GitHub Actions secrets
- [ ] Create `TSANet SLA Breach — Notify Assignee` Zendesk trigger
- [ ] Create TSANet Active Collaborations view; add custom field columns manually

---

## Reference: CollaborationRequestDTO Fields

| Field | Type | Notes |
|---|---|---|
| `token` | string | **Primary key — save this immediately** |
| `id` | int64 | Internal numeric ID |
| `status` | enum | OPEN, INFORMATION, ACCEPTED, REJECTED, CLOSED, PENDINGACTION. `/v2/` list filters also accept `ALL` |
| `direction` | enum | OUTBOUND (you submitted), INBOUND (you received) |
| `priority` | enum | LOW, MEDIUM, HIGH |
| `respondBy` | datetime | SLA deadline — truncate to YYYY-MM-DD for Zendesk date fields |
| `responded` | bool | `false` = SLA clock running; `true` = acknowledged |
| `submitterCaseNumber` | string | Your case number (set on submission) |
| `receiverCaseNumber` | string | Partner's case number (set on their acceptance) |
| `caseNotes` | array | All CaseNoteDTO records — HTML content, strip before display |
| `caseResponses` | array | Approval, rejection, info request records |
