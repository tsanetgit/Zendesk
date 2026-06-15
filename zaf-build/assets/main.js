/**
 * TSANet Connect ZAF App — v1.0.31
 * client.metadata() with .then() chains after app.registered
 * Includes: New Collaboration, Sync Inbound Cases, action buttons
 */
(function() {
'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
var client          = null;
var settings        = {};
var collaborations  = [];
var _jwt            = null;
var _jwtExpiry      = 0;
var selectedPartner = null;
var currentForm     = null;
var _modalCb        = null;

// ── ZAF Init ──────────────────────────────────────────────────────────────────
if (typeof ZAFClient === 'undefined') {
  show('loading', false);
  showError('Open inside a Zendesk ticket.');
} else {
  client = ZAFClient.init();

  client.on('app.registered', function() {
    client.metadata().then(function(meta) {
      settings = meta.settings || {};

      if (!settings.tsanet_username || !settings.tsanet_password) {
        show('loading', false);
        showError('TSANet credentials are empty. Go to Admin Center → Apps → TSANet Connect → Settings and enter your username and password.');
        return;
      }

      loadCollaborations();
      client.on('ticket.tags.changed', loadCollaborations);

    }).catch(function(err) {
      show('loading', false);
      showError('Could not load app settings: ' + (err.message || String(err)));
    });
  });
}

// ── TSANet Auth ───────────────────────────────────────────────────────────────
function baseUrl() {
  return (settings.tsanet_env === 'PRODUCTION')
    ? 'https://connect2.tsanet.org/v1'
    : 'https://connect2.tsanet.net/v1';
}

function getJwt() {
  if (_jwt && Date.now() < _jwtExpiry) return Promise.resolve(_jwt);
  return fetch(baseUrl() + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: settings.tsanet_username, password: settings.tsanet_password })
  }).then(function(res) {
    if (!res.ok) return res.text().then(function(t) {
      throw new Error('TSANet login failed (HTTP ' + res.status + '). Check credentials. Server: ' + t.substring(0,80));
    });
    return res.json();
  }).then(function(d) {
    if (!d.accessToken) throw new Error('TSANet login returned no token');
    _jwt = d.accessToken;
    _jwtExpiry = Date.now() + 50 * 60 * 1000;
    return _jwt;
  });
}

function tsanetGet(path) {
  return getJwt().then(function(jwt) {
    return fetch(baseUrl() + path, { headers: { Authorization: 'Bearer ' + jwt } });
  }).then(function(res) {
    if (res.status === 401) { _jwt = null; return tsanetGet(path); }
    if (!res.ok) throw new Error('TSANet GET failed: ' + res.status);
    return res.json();
  });
}

function tsanetPost(path, body) {
  return getJwt().then(function(jwt) {
    return fetch(baseUrl() + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt },
      body: JSON.stringify(body)
    });
  }).then(function(res) {
    if (res.status === 401) { _jwt = null; return tsanetPost(path, body); }
    if (!res.ok) return res.json().catch(function() { return {}; }).then(function(errBody) {
      // Surface TSANet's actual error message if present, not just the HTTP status
      var msg = errBody.message || errBody.error || errBody.detail || ('HTTP ' + res.status);
      throw new Error(msg);
    });
    return res.json();
  });
}

// ── Zendesk helpers ───────────────────────────────────────────────────────────
function getTicket() {
  return client.get('ticket').then(function(d) { return d.ticket; });
}

// Read tokens via Zendesk REST API (reliable — ZAF custom field path API is version-sensitive)
function getTokens() {
  return client.get('ticket.id').then(function(d) {
    var ticketId = d['ticket.id'];
    return client.request({
      url: '/api/v2/tickets/' + ticketId + '.json',
      type: 'GET'
    }).then(function(data) {
      var cf = data.ticket.custom_fields || [];
      var tokenField = cf.find(function(f) { return String(f.id) === String(settings.field_id_token); });
      var multiField = cf.find(function(f) { return String(f.id) === String(settings.field_id_tokens_multi); });
      var primary = tokenField ? (tokenField.value || null) : null;
      var multi = [];
      try { multi = JSON.parse(multiField && multiField.value ? multiField.value : '[]'); } catch(e) {}
      var all = primary ? [primary] : [];
      for (var i = 0; i < multi.length; i++) {
        if (multi[i] && all.indexOf(multi[i]) === -1) all.push(multi[i]);
      }
      return all;
    });
  });
}

function getTicketId() {
  return client.get('ticket.id').then(function(d) { return d['ticket.id']; });
}

function writeFields(ticketId, fields) {
  return client.request({
    url: '/api/v2/tickets/' + ticketId + '.json',
    type: 'PUT',
    contentType: 'application/json',
    data: JSON.stringify({ ticket: { custom_fields: fields.map(function(f) {
      return { id: parseInt(f.id), value: f.value };
    }) } })
  });
}

// ── Load collaborations ───────────────────────────────────────────────────────
function loadCollaborations() {
  show('loading', true);
  hideInfoBanner();

  return getTokens().then(function(tokens) {
    if (!tokens.length) {
      // No TSANet data on this ticket — collapse to compact bar
      show('loading', false);
      show('compact-bar', true);
      client.invoke('resize', { width: '100%', height: '44px' });
      return;
    }
    // TSANet ticket — show full panel
    show('compact-bar', false);
    show('btn-new-collab', true);
    show('btn-sync-inbound', true);
    show('tsanet-notice', true);
    client.invoke('resize', { width: '100%', height: '600px' });
    show('empty-state', false);
    return Promise.all(tokens.map(function(t) {
      return tsanetGet('/collaboration-requests/' + t).catch(function() { return null; });
    })).then(function(results) {
      collaborations = results.filter(Boolean);
      renderAll();
      show('loading', false);
      // Sync live TSANet status back to Zendesk ticket fields
      syncStatusToTicket(collaborations);
    });
  }).catch(function(err) {
    show('loading', false);
    showError(err.message || String(err));
  });
}

// ── Status sync ──────────────────────────────────────────────────────────────
// Called after every load — writes live TSANet status back to Zendesk fields
// so ticket fields never go stale (e.g. OPEN showing when TSANet says ACCEPTED)
function syncStatusToTicket(collabs) {
  if (!collabs || !collabs.length) return;

  getTicketId().then(function(ticketId) {
    // Use the first collaboration's status as the primary (most tickets have one)
    var primary = collabs[0];
    var zdStatus = 'tsanet_status_' + primary.status.toLowerCase();

    // Read current Zendesk status field
    client.request({
      url: '/api/v2/tickets/' + ticketId + '.json',
      type: 'GET'
    }).then(function(data) {
      var cf = data.ticket.custom_fields || [];
      var statusField = cf.find(function(f) { return String(f.id) === String(settings.field_id_status); });
      var currentZdStatus = statusField ? statusField.value : null;

      var updates = [];

      // Sync status if drifted
      if (currentZdStatus !== zdStatus) {
        console.log('[TSANet] Syncing status: ' + currentZdStatus + ' → ' + zdStatus);
        updates.push({ id: settings.field_id_status, value: zdStatus });
      }

      // Also sync token field if missing
      var tokenField = cf.find(function(f) { return String(f.id) === String(settings.field_id_token); });
      if (!tokenField || !tokenField.value) {
        updates.push({ id: settings.field_id_token, value: primary.token });
      }

      // Sync partner name
      var partnerField = cf.find(function(f) { return String(f.id) === String(settings.field_id_partner); });
      var partner = primary.direction === 'INBOUND' ? primary.submitCompanyName : primary.receiveCompanyName;
      if (!partnerField || partnerField.value !== partner) {
        updates.push({ id: settings.field_id_partner, value: partner });
      }

      // Sync respond_by deadline — only while SLA is active (responded === false = OPEN).
      // Clear the field once acknowledged so Zendesk automations don't fire on cases
      // where the SLA obligation has already been met.
      // Zendesk date fields require YYYY-MM-DD; TSANet respondBy is ISO datetime.
      if (settings.field_id_respond_by) {
        var respondByField = cf.find(function(f) { return String(f.id) === String(settings.field_id_respond_by); });
        var newRespondBy = (primary.respondBy && primary.responded === false)
          ? primary.respondBy.substring(0, 10)  // Extract YYYY-MM-DD from ISO string
          : null;                                // Clear once acknowledged
        var currentRespondBy = respondByField ? respondByField.value : null;
        if (currentRespondBy !== newRespondBy) {
          updates.push({ id: settings.field_id_respond_by, value: newRespondBy });
        }
      }

      if (updates.length) {
        writeFields(ticketId, updates).catch(function(e) {
          console.warn('[TSANet] Status sync write failed:', e.message);
        });
      }
    }).catch(function() {}); // silent — sync is best-effort
  }).catch(function() {});
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderAll() {
  var list = document.getElementById('collab-list');
  list.innerHTML = '';
  hideInfoBanner();

  var infoCollab = null;
  for (var i = 0; i < collaborations.length; i++) {
    if (collaborations[i].status === 'INFORMATION' && collaborations[i].direction === 'OUTBOUND') {
      infoCollab = collaborations[i]; break;
    }
  }
  if (infoCollab) {
    var req = null;
    var responses = infoCollab.caseResponses || [];
    for (var j = responses.length - 1; j >= 0; j--) {
      if (responses[j].type === 'INFORMATION_REQUEST') { req = responses[j]; break; }
    }
    var token = infoCollab.token;
    showInfoBanner(req ? req.requestedInformation : null, function() { handleRespondInfo(token); });
  }

  for (var k = 0; k < collaborations.length; k++) {
    list.appendChild(renderCard(collaborations[k]));
  }
  if (!collaborations.length) show('empty-state', true);
}

function renderCard(collab) {
  var isInbound = collab.direction === 'INBOUND';
  var partner   = isInbound ? collab.submitCompanyName : collab.receiveCompanyName;
  var sla       = slaDisplay(collab.respondBy);

  // SLA = acknowledgment only. Once responded (Accept/Reject/Req Info), TSANet
  // stops tracking — "the system no longer tracks the case." Only show countdown
  // on OPEN cases where the initial response is still outstanding.
  var showSla = collab.respondBy && collab.responded === false;

  var card = document.createElement('div');
  card.className = 'collab-card';
  card.innerHTML =
    '<div class="card-header">' +
      '<span class="card-partner">' + esc(partner) + '</span>' +
      '<span class="status-badge status-' + collab.status + '">' + collab.status + '</span>' +
    '</div>' +
    '<div class="card-body">' +
      '<div class="card-row"><span class="card-label">Direction</span><span class="card-value">' + (isInbound ? '← Inbound' : 'Outbound →') + '</span></div>' +
      '<div class="card-row"><span class="card-label">Priority</span><span class="card-value">' + (collab.priority || '—') + '</span></div>' +
      (showSla ? '<div class="card-row"><span class="card-label">SLA</span><span class="card-value ' + sla.css + '">' + esc(sla.label) + '</span></div>' : '') +
      (collab.summary   ? '<div class="card-row"><span class="card-label">Summary</span><span class="card-value" style="max-width:60%;white-space:normal;text-align:right;">' + esc(collab.summary) + '</span></div>' : '') +
    '</div>' +
    '<div class="card-actions" id="actions-' + collab.token + '"></div>';

  addActionButtons(card.querySelector('#actions-' + collab.token), collab);

  // Load and display TSANet notes for this collaboration
  var notesContainer = document.createElement('div');
  notesContainer.id = 'notes-' + collab.token;
  notesContainer.className = 'notes-container';
  notesContainer.innerHTML = '<div class="notes-loading">Loading notes...</div>';
  card.appendChild(notesContainer);
  loadNotes(collab.token, notesContainer);

  return card;
}

function loadNotes(token, container) {
  tsanetGet('/collaboration-requests/' + token + '/notes').then(function(notes) {
    if (!notes || !notes.length) {
      container.innerHTML = '<div class="notes-empty">No notes yet.</div>';
      return;
    }
    var html = '<div class="notes-header">Notes (' + notes.length + ')</div>';
    notes.slice().reverse().forEach(function(note) {
      var d = new Date(note.createdAt);
      var dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
      var bodyText = note.description ? stripHtml(note.description) : '';
      html += '<div class="note-item">' +
        '<div class="note-meta">' + esc(note.companyName) + ' · ' + esc(dateStr) + '</div>' +
        '<div class="note-summary">' + esc(stripHtml(note.summary)) + '</div>' +
        (bodyText && bodyText !== stripHtml(note.summary) ? '<div class="note-body">' + esc(bodyText) + '</div>' : '') +
        '</div>';
    });
    container.innerHTML = html;
    // Mirror any new TSANet notes to Zendesk ticket as internal comments
    syncNotesToZendesk(notes);
  }).catch(function() {
    container.innerHTML = '';
  });
}

// ── Sync TSANet notes → Zendesk internal comments ─────────────────────────────
// Fetches existing ticket comments, finds TSANet notes not yet posted (by marker),
// and adds them as internal notes so agents can see them without opening ZAF.
function syncNotesToZendesk(notes) {
  if (!notes || !notes.length) return;

  getTicketId().then(function(ticketId) {
    // Fetch existing comments to check which notes are already synced
    client.request({
      url: '/api/v2/tickets/' + ticketId + '/comments.json?per_page=100',
      type: 'GET'
    }).then(function(data) {
      var existingBodies = (data.comments || []).map(function(c) {
        return c.plain_body || '';
      });

      // Filter to only notes not yet in Zendesk
      var unsyncedNotes = notes.filter(function(note) {
        var marker = 'tsanet-note-id:' + note.id;
        return !existingBodies.some(function(body) { return body.indexOf(marker) !== -1; });
      });

      if (!unsyncedNotes.length) return;

      // Post each unsynced note as an internal comment, sequentially
      unsyncedNotes.reduce(function(chain, note) {
        return chain.then(function() {
          var d = new Date(note.createdAt);
          var dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
          var summary = stripHtml(note.summary || '');
          var description = note.description ? stripHtml(note.description) : '';

          var body = '[TSANet Note] ' + (note.companyName || 'Partner') + ' — ' + dateStr
            + '\n\n' + summary;
          if (description && description !== summary) {
            body += '\n\n' + description;
          }
          body += '\n\ntsanet-note-id:' + note.id;

          return client.request({
            url: '/api/v2/tickets/' + ticketId + '.json',
            type: 'PUT',
            contentType: 'application/json',
            data: JSON.stringify({
              ticket: {
                comment: { body: body, public: false }
              }
            })
          }).catch(function(e) {
            console.warn('[TSANet] Note sync failed for note', note.id, e.message);
          });
        });
      }, Promise.resolve());

    }).catch(function() {}); // silent — best-effort
  }).catch(function() {});
}

function addActionButtons(el, collab) {
  var s = collab.status, d = collab.direction, t = collab.token;
  function btn(label, cls, fn) {
    var b = document.createElement('button');
    b.className = 'btn-action' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.onclick = function() { fn(t); };
    el.appendChild(b);
  }
  if (s === 'OPEN'        && d === 'INBOUND')  { btn('Accept', 'primary', handleAccept); btn('Req Info', '', handleRequestInfo); btn('Reject', 'danger', handleReject); btn('Add Note', '', handleAddNote); }
  if (s === 'INFORMATION' && d === 'INBOUND')  { btn('Accept', 'primary', handleAccept); btn('Reject', 'danger', handleReject); btn('Add Note', '', handleAddNote); }
  if (s === 'INFORMATION' && d === 'OUTBOUND') { btn('Respond Now', 'primary', handleRespondInfo); btn('Add Note', '', handleAddNote); }
  if (s === 'ACCEPTED' && d === 'OUTBOUND')    { btn('Add Note', '', handleAddNote); btn('Close', 'danger', handleClose); }
  if (s === 'ACCEPTED' && d === 'INBOUND')     { btn('Add Note', '', handleAddNote); }
  if (s === 'OPEN'        && d === 'OUTBOUND') btn('Add Note', '', handleAddNote);
}

// ── Sync Inbound Cases ────────────────────────────────────────────────────────
function syncInboundCases() {
  var btn = document.getElementById('btn-sync-inbound');
  btn.disabled = true;
  btn.textContent = 'Syncing...';

  tsanetGet('/collaboration-requests?type=INBOUND').then(function(cases) {
    var open = (cases || []).filter(function(c) {
      return c.status === 'OPEN' || c.status === 'INFORMATION';
    });

    if (!open.length) {
      showSuccess('No open inbound cases in TSANet.');
      btn.disabled = false; btn.textContent = '\u2199 Sync Inbound';
      return;
    }

    // Check which tokens already have a Zendesk ticket
    Promise.all(open.map(function(collab) {
      return client.request({
        url: '/api/v2/search.json?query=custom_field_' + settings.field_id_token + ':' + collab.token + '&type=ticket',
        type: 'GET'
      }).then(function(res) {
        return { collab: collab, exists: res.count > 0 };
      });
    })).then(function(checked) {
      var toCreate = checked.filter(function(r) { return !r.exists; });

      if (!toCreate.length) {
        showSuccess('All ' + open.length + ' inbound case(s) already have tickets.');
        btn.disabled = false; btn.textContent = '\u2199 Sync Inbound';
        return;
      }

      // Create a Zendesk ticket for each missing case
      Promise.all(toCreate.map(function(r) {
        var c = r.collab;
        var zdPriority = c.priority === 'HIGH' ? 'urgent' : c.priority === 'MEDIUM' ? 'normal' : 'low';
        return client.request({
          url: '/api/v2/tickets.json',
          type: 'POST',
          contentType: 'application/json',
          data: JSON.stringify({
            ticket: {
              subject: 'TSANet Inbound from ' + c.submitCompanyName + ': ' + c.summary,
              description: 'Inbound TSANet Collaboration Request.\n\nFrom: ' + c.submitCompanyName +
                '\nPriority: ' + c.priority + '\nToken: ' + c.token +
                '\n\n' + (c.description || ''),
              priority: zdPriority,
              tags: ['tsanet_inbound', 'tsanet_status_open'],
              comment: {
                body: '\u2b05\ufe0f Inbound TSANet Collaboration Request from ' + c.submitCompanyName +
                  '.\n\nPriority: ' + c.priority + '\nToken: ' + c.token +
                  '\n\nUse the TSANet Connect app to Accept, Request Info, or Reject.',
                public: false
              },
              custom_fields: [
                { id: parseInt(settings.field_id_token),   value: c.token },
                { id: parseInt(settings.field_id_status),  value: 'tsanet_status_open' },
                { id: parseInt(settings.field_id_partner), value: c.submitCompanyName }
              ]
            }
          })
        });
      })).then(function() {
        showSuccess('\u2705 Created ' + toCreate.length + ' ticket(s) for inbound cases.');
        btn.disabled = false; btn.textContent = '\u2199 Sync Inbound';
      }).catch(function(err) {
        showError('Ticket creation failed: ' + (err.message || String(err)));
        btn.disabled = false; btn.textContent = '\u2199 Sync Inbound';
      });

    }).catch(function(err) {
      showError('Search failed: ' + (err.message || String(err)));
      btn.disabled = false; btn.textContent = '\u2199 Sync Inbound';
    });

  }).catch(function(err) {
    showError('TSANet fetch failed: ' + (err.message || String(err)));
    btn.disabled = false; btn.textContent = '\u2199 Sync Inbound';
  });
}

// ── Button listeners (wired inline — DOM is always ready when ZAF loads) ─────
var _searchTimer;

document.getElementById('modal-ok').addEventListener('click', function() {
  var inp = document.getElementById('modal-input');
  var inp2 = document.getElementById('modal-input2');
  var wrap2 = document.getElementById('modal-input2-wrap');
  var value = inp.style.display !== 'none' ? inp.value.trim() : true;
  var value2 = (wrap2 && wrap2.style.display !== 'none') ? inp2.value.trim() : null;
  var cb = _modalCb;
  _modalCb = null;
  document.getElementById('tsanet-modal').style.display = 'none';
  if (cb) cb(value, value2);
});

document.getElementById('modal-cancel').addEventListener('click', function() {
  _modalCb = null;
  document.getElementById('tsanet-modal').style.display = 'none';
});

document.getElementById('btn-sync-inbound').addEventListener('click', syncInboundCases);

// Compact-bar "+ New" (shown on no-token tickets). Wired here, not via an inline
// onclick attribute — inline event handlers are blocked by the ZAF iframe CSP and
// silently do nothing. enterNewCollaboration is a hoisted function declaration below.
document.getElementById('btn-compact-new').addEventListener('click', enterNewCollaboration);

document.getElementById('btn-new-collab').addEventListener('click', function() {
  var d = document.getElementById('new-collab-dialog');
  d.style.display = d.style.display === 'none' ? 'block' : 'none';
  if (d.style.display === 'block') {
    document.getElementById('partner-search-input').value = '';
    document.getElementById('partner-results').innerHTML = '';
    document.getElementById('collab-form').style.display = 'none';
    selectedPartner = null; currentForm = null;
  }
});

// Called from compact-bar "+ New" button on non-TSANet tickets.
// Expands the panel to full height and opens the New Collaboration dialog.
function enterNewCollaboration() {
  show('compact-bar', false);
  show('btn-new-collab', true);
  show('btn-sync-inbound', true);
  show('tsanet-notice', true);
  show('empty-state', true);
  client.invoke('resize', { width: '100%', height: '600px' });
  var d = document.getElementById('new-collab-dialog');
  d.style.display = 'block';
  document.getElementById('partner-search-input').value = '';
  document.getElementById('partner-results').innerHTML = '';
  document.getElementById('collab-form').style.display = 'none';
  selectedPartner = null; currentForm = null;
}

document.getElementById('partner-search-input').addEventListener('input', function() {
  clearTimeout(_searchTimer);
  var q = this.value.trim();
  if (q.length < 2) { document.getElementById('partner-results').innerHTML = ''; return; }
  _searchTimer = setTimeout(function() { doPartnerSearch(q); }, 350);
});

function doPartnerSearch(q) {
  var res = document.getElementById('partner-results');
  res.innerHTML = '<div style="padding:6px;color:#68737d;font-size:12px;">Searching...</div>';
  tsanetGet('/partners/' + encodeURIComponent(q)).then(function(partners) {
    res.innerHTML = '';
    if (!partners || !partners.length) {
      res.innerHTML = '<div style="padding:6px;color:#68737d;font-size:12px;">No results.</div>';
      return;
    }
    partners.forEach(function(p) {
      var item = document.createElement('div');
      item.className = 'partner-result';
      item.textContent = p.label || p.companyName;
      item.onclick = function() { selectPartner(p, item); };
      res.appendChild(item);
    });
  }).catch(function(err) {
    res.innerHTML = '<div style="padding:6px;color:#cc3340;font-size:12px;">Search failed: ' + esc(err.message) + '</div>';
  });
}

function selectPartner(partner, itemEl) {
  var items = document.querySelectorAll('.partner-result');
  for (var i = 0; i < items.length; i++) items[i].classList.remove('selected');
  itemEl.classList.add('selected');
  selectedPartner = partner;
  var form = document.getElementById('collab-form');
  form.style.display = 'none'; form.innerHTML = '';
  var url = partner.departmentId
    ? '/forms/department/' + partner.departmentId
    : '/forms/company/' + partner.companyId;
  tsanetGet(url).then(function(formData) {
    currentForm = formData;
    renderCollabForm(formData);
    form.style.display = 'block';
  }).catch(function(err) { showError('Form load failed: ' + err.message); });
}

function renderCollabForm(formData) {
  var form = document.getElementById('collab-form');
  form.innerHTML = '';
  if (formData.adminNote) {
    var n = document.createElement('div'); n.className = 'admin-note';
    n.innerHTML = '<strong>Partner instructions:</strong> ' + sanitizeHtml(formData.adminNote);
    form.appendChild(n);
  }
  addFormField(form, 'Priority', '<select id="form-priority"><option value="HIGH">HIGH (P1)</option><option value="MEDIUM" selected>MEDIUM (P2)</option><option value="LOW">LOW (P3)</option></select>');
  addFormField(form, 'Problem Summary *', '<input type="text" id="form-summary" required />');
  addFormField(form, 'Problem Description *', '<textarea id="form-description" required></textarea>');
  (formData.customFields || []).forEach(function(f) {
    if (f.type === 'SELECT') {
      // Picklist values: prefer the structured selections[] array (FieldMetadataDTO);
      // otherwise parse the options string. TSANet delimits options with newlines
      // (CRLF), so split on newlines first and fall back to commas for any legacy
      // comma-delimited form.
      var optValues;
      if (Array.isArray(f.selections) && f.selections.length) {
        optValues = f.selections.map(function(s) { return s && s.value != null ? String(s.value).trim() : ''; }).filter(Boolean);
      } else {
        var rawOpts = f.options || '';
        optValues = rawOpts.split(/\r\n|\r|\n/).map(function(o) { return o.trim(); }).filter(Boolean);
        if (optValues.length <= 1) optValues = rawOpts.split(',').map(function(o) { return o.trim(); }).filter(Boolean);
      }
      var opts = optValues
        .map(function(o) { return '<option value="' + esc(o) + '">' + esc(o) + '</option>'; }).join('');
      addFormField(form, f.label + (f.required ? ' *' : ''), '<select id="cf-' + f.fieldId + '"><option value="">Select...</option>' + opts + '</select>');
    } else {
      addFormField(form, f.label + (f.required ? ' *' : ''), '<input type="text" id="cf-' + f.fieldId + '" />');
    }
  });
  var actions = document.createElement('div'); actions.className = 'form-actions';
  actions.innerHTML = '<button class="btn-cancel" id="btn-cancel-form">Cancel</button><button class="btn-submit" id="btn-submit-collab">Submit</button>';
  form.appendChild(actions);
  document.getElementById('btn-cancel-form').onclick = function() {
    document.getElementById('new-collab-dialog').style.display = 'none';
  };
  document.getElementById('btn-submit-collab').onclick = handleSubmit;
}

function addFormField(container, label, html) {
  var d = document.createElement('div'); d.className = 'form-field';
  d.innerHTML = '<label>' + esc(label) + '</label>' + html;
  container.appendChild(d);
}

function handleSubmit() {
  var summary     = (document.getElementById('form-summary')     || {}).value || '';
  var description = (document.getElementById('form-description') || {}).value || '';
  var priority    = (document.getElementById('form-priority')    || {}).value || 'MEDIUM';
  summary = summary.trim(); description = description.trim();
  if (!summary || !description) { alert('Please fill in Summary and Description.'); return; }

  var btn = document.getElementById('btn-submit-collab');
  btn.disabled = true; btn.textContent = 'Submitting...';

  var customFields = (currentForm && currentForm.customFields || []).map(function(f) {
    var el = document.getElementById('cf-' + f.fieldId);
    return Object.assign({}, f, { value: el ? el.value : '' });
  });

  client.get(['ticket.id', 'ticket.requester']).then(function(d) {
    var ticketId  = d['ticket.id'];
    var requester = d['ticket.requester'] || {};
    var payload = {
      documentId:              currentForm && currentForm.documentId,
      internalCaseNumber:      String(ticketId),
      problemSummary:          summary,
      problemDescription:      description,
      priority:                priority,
      testSubmission:          (settings.tsanet_env || 'BETA') === 'BETA',
      submitterContactDetails: {
        name:  requester.name  || '',
        email: requester.email || ''
      },
      customFields: customFields
    };
    if (selectedPartner && selectedPartner.departmentId) payload.receiverDepartmentId = selectedPartner.departmentId;
    else if (selectedPartner) payload.receiverCompanyId = selectedPartner.companyId;

    return tsanetPost('/collaboration-requests', payload).then(function(created) {
      return client.request({ url: '/api/v2/tickets/' + ticketId + '.json', type: 'GET' }).then(function(d2) {
        var cf2 = d2.ticket.custom_fields || [];
        var mf = cf2.find(function(f) { return String(f.id) === String(settings.field_id_tokens_multi); });
        var existingRaw = (mf && mf.value) ? mf.value : '[]';
        var existing = [];
        try { existing = JSON.parse(existingRaw); } catch(e) {}
        if (existing.indexOf(created.token) === -1) existing.push(created.token);
        return writeFields(ticketId, [
          { id: settings.field_id_token,        value: created.token },
          { id: settings.field_id_tokens_multi, value: JSON.stringify(existing) },
          { id: settings.field_id_status,       value: 'tsanet_status_open' }
        ]).then(function() {
          // Tag the originating ticket so outbound cases are filterable in a View
          // (mirrors the tsanet_inbound tag set on inbound ticket creation). POST is
          // additive; never PUT here, which would replace and wipe the support
          // ticket's own existing tags.
          return client.request({
            url: '/api/v2/tickets/' + ticketId + '/tags.json',
            type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ tags: ['tsanet_outbound'] })
          });
        }).then(function() {
          document.getElementById('new-collab-dialog').style.display = 'none';
          showSuccess('Collaboration request submitted!');
          return loadCollaborations();
        });
      });
    });
  }).catch(function(err) {
    btn.disabled = false; btn.textContent = 'Submit';
    showError('Submit failed: ' + (err.message || String(err)));
  });
}

// ── Modal helpers ─────────────────────────────────────────────────────────────
// ZAF runs in a cross-origin iframe — prompt() and confirm() are blocked by
// the browser sandbox and always return null/false. Use these modal helpers instead.
function showPrompt(msg, callback) {
  _modalCb = callback;
  document.getElementById('modal-msg').textContent = msg;
  document.getElementById('modal-input1-label').textContent = '';
  document.getElementById('modal-input1-label').style.display = 'none';
  var inp = document.getElementById('modal-input');
  inp.value = '';
  inp.style.display = 'block';
  var wrap2 = document.getElementById('modal-input2-wrap');
  wrap2.style.display = 'none';
  document.getElementById('modal-input2').value = '';
  document.getElementById('tsanet-modal').style.display = 'block';
  setTimeout(function() { inp.focus(); }, 30);
}

function showPrompt2(msg, label1, label2, callback) {
  _modalCb = callback;
  document.getElementById('modal-msg').textContent = msg;
  var lbl1 = document.getElementById('modal-input1-label');
  lbl1.textContent = label1;
  lbl1.style.display = 'block';
  var inp = document.getElementById('modal-input');
  inp.value = '';
  inp.style.display = 'block';
  var lbl2 = document.getElementById('modal-input2-label');
  lbl2.textContent = label2;
  var wrap2 = document.getElementById('modal-input2-wrap');
  wrap2.style.display = 'block';
  document.getElementById('modal-input2').value = '';
  document.getElementById('tsanet-modal').style.display = 'block';
  setTimeout(function() { inp.focus(); }, 30);
}

function showConfirm(msg, callback) {
  _modalCb = callback;
  document.getElementById('modal-msg').textContent = msg;
  document.getElementById('modal-input1-label').style.display = 'none';
  document.getElementById('modal-input').style.display = 'none';
  document.getElementById('modal-input2-wrap').style.display = 'none';
  document.getElementById('tsanet-modal').style.display = 'block';
}

// ── Action Handlers ───────────────────────────────────────────────────────────
function handleAccept(token) {
  showPrompt('Internal case number (optional):', function(cn) {
    // TSANet requires engineerEmail to match the company's registered domain.
    // settings.tsanet_username is always domain-valid; use it as the email.
    // Pull the agent's display name for context only (no domain restriction on name).
    client.get('currentUser').then(function(d) {
      var agent = d.currentUser || {};
      return tsanetPost('/collaboration-requests/' + token + '/approval', {
        engineerEmail: settings.tsanet_username,
        engineerName:  agent.name || '',
        caseNumber:    cn || '',
        nextSteps:     'Accepted.'
      });
    }).then(function() { showSuccess('Accepted.'); loadCollaborations(); })
      .catch(function(e) { showError('Accept failed: ' + e.message); });
  });
}
function handleReject(token) {
  showPrompt('Reason for rejection:', function(reason) {
    if (!reason) return;
    tsanetPost('/collaboration-requests/' + token + '/rejection', { reason: reason })
      .then(function() { showSuccess('Rejected.'); loadCollaborations(); })
      .catch(function(e) { showError('Reject failed: ' + e.message); });
  });
}
function handleRequestInfo(token) {
  showPrompt('What information do you need?', function(info) {
    if (!info) return;
    tsanetPost('/collaboration-requests/' + token + '/information-request', { requestedInformation: info })
      .then(function() { showSuccess('Info request sent.'); loadCollaborations(); })
      .catch(function(e) { showError('Request info failed: ' + e.message); });
  });
}
function handleRespondInfo(token) {
  showPrompt('Provide the requested information:', function(r) {
    if (!r) return;
    tsanetPost('/collaboration-requests/' + token + '/information-response', { requestedInformation: r })
      .then(function() { showSuccess('Response submitted.'); loadCollaborations(); })
      .catch(function(e) { showError('Respond failed: ' + e.message); });
  });
}
function handleClose(token) {
  showConfirm('Close this collaboration? This cannot be undone.', function(confirmed) {
    if (!confirmed) return;
    tsanetPost('/collaboration-requests/' + token + '/closure', {})
      .then(function() { showSuccess('Closed.'); loadCollaborations(); })
      .catch(function(e) { showError('Close failed: ' + e.message); });
  });
}
function handleAddNote(token) {
  showPrompt2('Add a note:', 'Subject', 'Details', function(subject, details) {
    if (!subject) return;
    var body = { summary: subject };
    if (details) body.description = details;
    tsanetPost('/collaboration-requests/' + token + '/notes', body)
      .then(function() { showSuccess('Note added.'); loadCollaborations(); })
      .catch(function(e) { showError('Note failed: ' + e.message); });
  });
}

// ── UI Helpers ────────────────────────────────────────────────────────────────
function show(id, on) {
  var el = document.getElementById(id);
  if (!el) return;
  if (!on) { el.style.display = 'none'; return; }
  // Elements that require display:flex
  var flexIds = { 'loading': true, 'tsanet-notice': true };
  el.style.display = flexIds[id] ? 'flex' : 'block';
}
function showInfoBanner(msg, onRespond) {
  document.getElementById('info-msg').textContent = msg || 'The partner has requested more information.';
  var oldBtn = document.getElementById('btn-respond-now');
  var newBtn = oldBtn.cloneNode(true);
  oldBtn.parentNode.replaceChild(newBtn, oldBtn);
  newBtn.onclick = onRespond;
  show('info-banner', true);
}
function hideInfoBanner() { show('info-banner', false); }
function showError(msg) {
  var el = document.getElementById('error-banner');
  el.textContent = msg; el.style.display = 'block';
  el.style.background = '#fff0f0'; el.style.borderColor = '#cc3340'; el.style.color = '#cc3340';
  show('loading', false);
  setTimeout(function() { el.style.display = 'none'; }, 10000);
}
function showSuccess(msg) {
  var el = document.getElementById('error-banner');
  el.textContent = msg; el.style.display = 'block';
  el.style.background = '#edf7ed'; el.style.borderColor = '#1a7a3a'; el.style.color = '#1a7a3a';
  setTimeout(function() {
    el.style.display = 'none';
    el.style.background = '#fff0f0'; el.style.borderColor = '#cc3340'; el.style.color = '#cc3340';
  }, 4000);
}
function slaDisplay(respondBy) {
  if (!respondBy) return { label: '—', css: '' };
  var rem = new Date(respondBy) - Date.now();
  if (rem <= 0) return { label: 'SLA BREACHED', css: 'sla-breach' };
  var h = Math.floor(rem / 3600000), m = Math.floor((rem % 3600000) / 60000);
  return { label: (h > 0 ? h + 'h ' : '') + m + 'm remaining', css: rem < 1800000 ? 'sla-red' : rem < 3600000 ? 'sla-amber' : 'sla-green' };
}
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Render partner-authored adminNote HTML safely. Allowlists a small set of
// formatting tags, strips everything else (scripts, event handlers, styles,
// inline CSS), and forces links to open in a new tab with noopener. Anything
// outside the allowlist is unwrapped to its text content rather than dropped.
function sanitizeHtml(html) {
  if (!html) return '';
  var ALLOWED = { P:1, BR:1, STRONG:1, B:1, EM:1, I:1, U:1, UL:1, OL:1, LI:1, A:1, SPAN:1 };
  var doc = new DOMParser().parseFromString(String(html), 'text/html');
  (function clean(node) {
    var child = node.firstChild;
    while (child) {
      var next = child.nextSibling;
      if (child.nodeType === 1) {            // element
        clean(child);                        // sanitize descendants first
        if (ALLOWED[child.tagName]) {
          var attrs = Array.prototype.slice.call(child.attributes);
          for (var i = 0; i < attrs.length; i++) {
            var name = attrs[i].name.toLowerCase();
            if (child.tagName === 'A' && name === 'href') {
              if (!/^https?:\/\//i.test(child.getAttribute('href') || '')) child.removeAttribute('href');
            } else {
              child.removeAttribute(attrs[i].name);
            }
          }
          if (child.tagName === 'A') {
            child.setAttribute('target', '_blank');
            child.setAttribute('rel', 'noopener noreferrer');
          }
        } else {                             // disallowed tag: unwrap to its children
          while (child.firstChild) node.insertBefore(child.firstChild, child);
          node.removeChild(child);
        }
      } else if (child.nodeType === 8) {     // comment
        node.removeChild(child);
      }
      child = next;
    }
  })(doc.body);
  return doc.body.innerHTML;
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<\/p>/gi, '\n').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n').trim();
}

})();
