# TSANet Connect — ZAF App Quick Start Guide

**App version:** see the [latest release](https://github.com/tsanetgit/Zendesk_App/releases/latest) — always use the newest ZIP, this guide is not version-specific  
**Last updated:** July 2026  
**Time to complete:** ~30 minutes

This guide gets the TSANet Connect sidebar app installed and working in your Zendesk instance. When done, agents will see all active TSANet collaboration cases directly on every ticket.

---

## Prerequisites

Before starting, make sure you have:

| Requirement | Notes |
|---|---|
| Zendesk Admin access | You need Apps & Integrations → Private Apps permission |
| TSANet API credentials | Email membership@tsanet.org to request a dedicated API user |
| TSANet environment | BETA (`connect2.tsanet.net`) or PRODUCTION (`connect2.tsanet.org`) |
| App ZIP file | Downloaded from the [latest release](https://github.com/tsanetgit/Zendesk_App/releases/latest) — filename is `tsanet-connect-v<version>.zip`; always grab the current one, not a version pinned in this guide |

---

## Step 1 — Create the Zendesk Custom Fields

The app uses four custom ticket fields to store TSANet data. Create each one in **Admin Center → Objects and rules → Tickets → Fields**.

| Field Label | Type | Note |
|---|---|---|
| TSANet Token | Text | Primary key — links ticket to TSANet case |
| TSANet Status | Dropdown | Values: `tsanet_status_open`, `tsanet_status_accepted`, `tsanet_status_information`, `tsanet_status_rejected`, `tsanet_status_closed` |
| TSANet Partner | Text | Stores the partner company name |
| TSANet Respond By | Date | SLA acknowledgment deadline (auto-cleared on acknowledgment) |

**After creating each field, note its Field ID** (shown in the URL when you click the field, e.g. `1234567890`). You'll need all four IDs in Step 3.

> **Optional:** Create a fifth field **TSANet Tokens Multi** (Text) if you need to store multiple token references on a single ticket. Add its ID to the `field_id_tokens_multi` setting.

---

## Step 2 — Install the App

1. Go to **Admin Center → Apps and Integrations → Zendesk Support Apps**
2. Click **Upload private app** (top-right)
3. Give it a name: `TSANet Connect`
4. Upload the ZIP you downloaded from the [latest release](https://github.com/tsanetgit/Zendesk_App/releases/latest) (`tsanet-connect-v<version>.zip`)
5. Click **Upload**

Zendesk will validate the package and show the installation settings screen.

---

## Step 3 — Configure App Settings

Fill in the settings on the installation screen:

| Setting | Value | Required |
|---|---|---|
| **TSANet API username** | Your TSANet API user email (e.g. `api@yourcompany.com`) | ✅ |
| **TSANet API password** | TSANet API user password | ✅ |
| **TSANet environment** | `BETA` or `PRODUCTION` | ✅ |
| **Zendesk Field ID for TSANet Token** | Field ID from Step 1 | ✅ |
| **Zendesk Field ID for TSANet Tokens Multi** | Field ID from Step 1 (optional) | ❌ |
| **Zendesk Field ID for TSANet Status** | Field ID from Step 1 | ✅ |
| **Zendesk Field ID for TSANet Partner** | Field ID from Step 1 | ✅ |
| **Zendesk Field ID for TSANet Respond By** | Field ID from Step 1 | ✅ |

Click **Install**.

---

## Step 4 — Verify the Installation

1. Open a Zendesk ticket that has **no TSANet collaboration** associated with it
2. The **TSANet Connect** panel should appear collapsed to a slim bar (~44px) with the text **"No active TSANet cases"** and a **+ New** button
3. Click **+ New** — the panel should expand to full height and open the New Collaboration search dialog
4. Search for a known TSANet member to confirm the form loads and partner lookup works

Now open a ticket that **does** have a TSANet token set in the TSANet Token field:
5. The panel should expand automatically to full height and display the TSANet case details

> If the sidebar shows an error instead of the compact bar, double-check that your TSANet API credentials are correct and that the TSANet environment setting matches where your account is provisioned (BETA vs PRODUCTION).

---

## Step 5 — Create the SLA Breach Trigger (Recommended)

This Zendesk trigger emails the ticket assignee the moment an SLA breach is detected.

1. Go to **Admin Center → Objects and rules → Business rules → Triggers**
2. Click **Add trigger** and name it: `TSANet SLA Breach — Notify Assignee`
3. Set **Meet ALL of the following conditions:**
   - `Update type` | `is` | `Changed`
   - `Current tags` | `includes` | `tsanet_sla_breached`
4. Set the **Action:**
   - `Notify user` → `(Assignee)`
   - Subject: `⚠️ TSANet SLA Breached — Action Required`
   - Body:
     ```
     A TSANet collaboration request on ticket {{ticket.title}} ({{ticket.url}}) 
     has breached its acknowledgment SLA deadline.

     Please open the TSANet Connect panel and Accept, Reject, or Request More Info 
     immediately to acknowledge the case.
     ```
5. Click **Create**

> This trigger fires when the `tsanet_sla_breached` tag is added — normally by the ZAF background poller while an agent has Zendesk open. If you want the tag applied even when no agent is online, see the optional, externally-hosted [GitHub Actions SLA Monitor (Optional)](GitHub_Actions_SLA_Monitor.md) — not required for the integration to work.

---

## What the App Does

The sidebar panel adapts based on whether the current ticket is linked to a TSANet collaboration:

**On tickets with no TSANet case (compact mode):**
- Collapses to a slim 44px bar: "No active TSANet cases · + New"
- Clicking **+ New** expands the panel and opens the New Collaboration dialog
- Keeps the sidebar tidy and unobtrusive for regular support tickets

**On tickets with a TSANet case (full panel):**
- **All active TSANet collaborations** linked to that ticket
- **Case status** — OPEN, INFORMATION, ACCEPTED, REJECTED, CLOSED
- **SLA countdown** — color-coded timer on OPEN (unacknowledged) cases only
  - 🟢 Green: more than 1 hour remaining
  - 🟡 Amber: 30–60 minutes remaining
  - 🔴 Red: under 30 minutes remaining
  - ⚠️ BREACHED: deadline passed
- **Partner engineer contact details** (once accepted)
- **Action buttons:** Accept, Reject, Request Info, Respond, Add Note (Subject + Details, with an **Internal / Partner only / Public** choice), Close (outbound only)

**Background behavior (always active while Zendesk is open):**
- Inbound cases are created **server-side by ZIS push** — the TSANet webhook delivers to ZIS (secured by callbackAuth) and a Zendesk ticket is created automatically. The sidebar's 1-minute poll is now a **fallback** that defers to push, so no duplicate ticket is created when push is working.
- Checks for SLA breaches and adds the `tsanet_sla_breached` tag to overdue tickets, firing the email trigger
- Mirrors TSANet collaboration notes to the Zendesk ticket thread as **internal comments** — agents can read partner communication directly in the ticket without opening the sidebar. Each note is labeled by direction — **You** for notes you sent, the partner company for notes received (sidebar and mirrored comment). A note that is your own forwarded **public** reply is skipped, so it doesn't echo back as a duplicate internal comment.

> **SLA scope:** The countdown and breach alerting only apply to the **initial acknowledgment** deadline. Once a case is Accepted, Rejected, or Info Requested, TSANet stops tracking the SLA and the countdown disappears.

---

## Notes: Internal / Partner-only / Public

A note can go to three different audiences. The app's **Add Note** dialog gives you all three as a Visibility choice:

| Add Note → Visibility | Goes to the **partner**? | Visible to the **end customer**? |
|---|---|---|
| **Internal** (default) | No | No — internal Zendesk comment only |
| **Partner only** | **Yes** (TSANet note) | No — surfaces as an internal Zendesk comment for your record |
| **Public** | **Yes** (forwarded as a TSANet note) | Yes — posted as a public reply |

**Partner-only** is the middle tier: the partner sees it, the end customer does not. It posts the note straight to TSANet and writes no public reply; you still get an internal record on the ticket. (Added in app v1.0.43.)

### Heads-up: Zendesk's native reply menu is only Public / Internal

Zendesk's own composer toggle offers just **Public reply** and **Internal note** — that control belongs to Zendesk and **cannot be extended to a third option**. So partner-only is available **only** through the app's **Add Note** dialog (or, without the app, the **TSANet Action** field — see the ZIS Quick Start). If an agent types directly in the native composer:

| Native composer | Partner? | Customer? |
|---|---|---|
| **Public reply** | **Yes** (forwarded automatically) | Yes |
| **Internal note** | No | No |

There is no native-composer way to reach the partner while hiding from the customer — use **Add Note → Partner only**. Public replies are forwarded to the partner automatically by a Zendesk trigger (see the ZIS Quick Start), so a public **Add Note** simply posts the public reply and lets that trigger deliver it, rather than sending it twice.

---

## Updating the App

Zendesk does not support API-based app binary updates. To update:

1. Go to **Admin Center → Apps and Integrations → Zendesk Support Apps**
2. Click the **TSANet Connect** app → **Update**
3. Upload the new ZIP file
4. Settings are preserved between updates — no need to re-enter credentials

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Sidebar shows "Credentials not configured" | Re-check TSANet username and password in app settings |
| Accept button returns "Error processing request" | Verify `tsanet_username` matches the domain registered with TSANet (e.g. `api@yourcompany.com`, not an agent's personal email) |
| New Collaboration search returns no results | Partner may not be in TSANet; check connect.tsanet.org for their membership |
| SLA countdown missing on OPEN case | `respondBy` field may be null — TSANet sets it based on your group SLA configuration |
| Background poller not creating tickets | Check browser console (`[TSANet BG]` log prefix); ensure credentials are set and TSANet has INBOUND cases |

---

## Field ID Reference (TSANet Dev Instance — `d3v-tsanet.zendesk.com`)

> **Example only.** The IDs below are placeholders. Your Zendesk account will have entirely different IDs. The install dialog ships with empty defaults, so you must enter your own.

| Field | Example Field ID (yours will differ) |
|---|---|
| TSANet Token | `1234567890` |
| TSANet Tokens Multi | `1234567891` |
| TSANet Status | `1234567892` |
| TSANet Partner | `1234567893` |
| TSANet Respond By | `1234567894` |
