// ============================================================
// SPECIALTY HOME PAINTING — CHAT WIDGET
//
// Talks to POST /chat (NDJSON stream). Each turn the server returns:
//   {type:"delta", text}                 streamed reply text (live preview)
//   {type:"done", reply, quote, buttons} final reply + structured quote
//                                         (or null) + soft action buttons
//   {type:"error", error}                failure
//
// Money and buttons come from the server (deterministic pricer +
// orchestrator). The widget renders the reply, stores the structured
// quote for the PDF/email, and dispatches buttons by their `action`.
//
// Requires (already in index.html): jsPDF (window.jspdf), EmailJS
// (window.emailjs, init()'d), and the #chat* DOM nodes.
// ============================================================

(function () {
  'use strict';

  // ----------------------------------------------------------
  // CONFIG
  // ----------------------------------------------------------
  var CHAT_URL = '/chat';

  var EMAILJS_SERVICE = 'service_s9zggu9';
  var EMAILJS_QUOTE_TEMPLATE = 'template_66n8bpb'; // quote -> customer (To={{email}}), Bcc business
  var EMAILJS_LEAD_TEMPLATE  = 'template_yrs9zfk';  // lead  -> business (contact template)

  // EmailJS free plan drops Cc/Bcc, so we send a separate copy of every chat
  // email straight to the owner's inbox (reuses the quote template's To={{email}}).
  var OWNER_COPY_EMAIL = 'izeinoun@gmail.com';

  var BUSINESS = {
    name:  'Specialty Home Painting',
    phone: '(904) 514-7016',
    tel:   '9045147016',
    email: 'issam@specialtyhomepainting.com',
    site:  'specialtyhomepainting.com',
    addr:  '14370 Sapelo Beach Dr., Orlando, FL 32827'
  };

  var GREETING = "Hi! I can put together a quick estimate right here, or answer questions about the work. What are you looking to have done?";
  var STARTER_BUTTONS = [
    { label: 'Interior painting', action: 'reply' },
    { label: 'Door restoration', action: 'reply' },
    { label: 'Ask a question', action: 'reply' }
  ];

  // ----------------------------------------------------------
  // STATE
  // ----------------------------------------------------------
  var history = [];     // [{role, content}] — conversation so far
  var lastQuote = null; // most recent structured quote from the server, or null
  var busy = false;
  var started = false;

  // ----------------------------------------------------------
  // WIDGET STYLES (injected so index.html needs no edits)
  // ----------------------------------------------------------
  var css = document.createElement('style');
  css.textContent = [
    '.msg-bubble p { margin: 0 0 8px; } .msg-bubble p:last-child { margin-bottom: 0; }',
    '.msg-bubble strong { font-weight: 500; color: var(--charcoal); }',
    '.msg-bubble em { font-style: italic; }',
    '.msg-bubble ul { margin: 6px 0 8px; padding-left: 18px; }',
    '.msg-bubble li { margin-bottom: 3px; font-size: 13.5px; }',
    '.msg-bubble hr { border: none; border-top: 1px solid var(--border); margin: 10px 0; }',
    '.msg-bubble h4 { font-size: 14px; font-weight: 500; margin: 4px 0 6px; }',
    '.q-table { width: 100%; margin: 8px 0 10px; border-collapse: collapse; }',
    '.q-table td { padding: 5px 0; font-size: 13px; vertical-align: top;',
    '  border-bottom: 1px solid var(--border); }',
    '.q-table tr:last-child td { border-bottom: none; }',
    '.q-table td.q-desc { padding-right: 10px; line-height: 1.4; }',
    '.q-table td.q-cost { text-align: right; white-space: nowrap; font-weight: 500; }',
    '.q-total { display: flex; justify-content: space-between; align-items: baseline;',
    '  gap: 12px; margin: 10px 0 4px; padding-top: 8px;',
    '  border-top: 2px solid var(--accent); }',
    '.q-total-label { font-size: 13px; font-weight: 500; }',
    '.q-total-value { font-size: 16px; font-weight: 500; color: var(--accent); white-space: nowrap; }',
    '.q-note { font-size: 11.5px; color: var(--mid); line-height: 1.5; font-style: italic; margin-top: 8px; }',
    '.msg-bubble a { color: var(--accent); }'
  ].join('\n');
  document.head.appendChild(css);

  // ----------------------------------------------------------
  // DOM HELPERS
  // ----------------------------------------------------------
  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function scrollDown() {
    var m = $('chatMessages');
    if (m) m.scrollTop = m.scrollHeight;
  }

  function timeNow() {
    return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  // ----------------------------------------------------------
  // MARKDOWN -> HTML (escaped first, so model output can't inject HTML)
  // ----------------------------------------------------------
  function inlineMd(text) {
    return escapeHtml(text)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  function isTableRow(line) { return line.trim().charAt(0) === '|'; }
  function isTableSeparator(line) { return /^\|[\s\-:|]+\|?\s*$/.test(line.trim()); }
  function splitRow(line) {
    var cells = line.trim().split('|');
    if (cells.length && cells[0].trim() === '') cells.shift();
    if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
    return cells.map(function (c) { return c.trim(); });
  }

  function renderMarkdown(md) {
    var lines = String(md).replace(/\r/g, '').split('\n');
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];
      var t = line.trim();

      if (t === '') { i++; continue; }

      if (/^-{3,}$/.test(t) || /^_{3,}$/.test(t) || /^\*{3,}$/.test(t)) {
        out.push('<hr>'); i++; continue;
      }

      if (isTableRow(t)) {
        var rows = [];
        while (i < lines.length && isTableRow(lines[i].trim())) {
          if (!isTableSeparator(lines[i])) rows.push(splitRow(lines[i]));
          i++;
        }
        if (rows.length) {
          if (rows.length > 1 && /^item$/i.test(rows[0][0] || '') && /^cost$/i.test(rows[0][1] || '')) {
            rows.shift();
          }
          var html = '<table class="q-table">';
          rows.forEach(function (cells) {
            if (!cells.length) return;
            var desc = cells[0] || '';
            var cost = cells.length > 1 ? cells[cells.length - 1] : '';
            if (!desc && !cost) return;
            html += '<tr><td class="q-desc">' + inlineMd(desc) + '</td>' +
                    '<td class="q-cost">' + inlineMd(cost) + '</td></tr>';
          });
          html += '</table>';
          out.push(html);
        }
        continue;
      }

      var totalMatch = t.match(/^\*\*\s*Total:?\s*(.+?)\s*\*\*$/i);
      if (totalMatch) {
        out.push('<div class="q-total"><span class="q-total-label">Total</span>' +
                 '<span class="q-total-value">' + escapeHtml(totalMatch[1]) + '</span></div>');
        i++; continue;
      }

      if (/^[-*•]\s+/.test(t)) {
        var items = [];
        while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) {
          items.push('<li>' + inlineMd(lines[i].trim().replace(/^[-*•]\s+/, '')) + '</li>');
          i++;
        }
        out.push('<ul>' + items.join('') + '</ul>');
        continue;
      }

      if (/^#{1,6}\s+/.test(t)) {
        out.push('<h4>' + inlineMd(t.replace(/^#{1,6}\s+/, '')) + '</h4>');
        i++; continue;
      }

      if (/^\*\*[^*]+\*\*$/.test(t)) {
        out.push('<h4>' + inlineMd(t.replace(/\*\*/g, '')) + '</h4>');
        i++; continue;
      }

      var para = [];
      while (i < lines.length) {
        var pl = lines[i].trim();
        if (pl === '' || isTableRow(pl) || /^[-*•]\s+/.test(pl) ||
            /^-{3,}$/.test(pl) || /^#{1,6}\s+/.test(pl) ||
            /^\*\*\s*Total:?/i.test(pl)) break;
        para.push(pl); i++;
      }
      if (para.length) out.push('<p>' + inlineMd(para.join(' ')) + '</p>');
    }

    return out.join('');
  }

  // ----------------------------------------------------------
  // MESSAGE + BUTTON RENDERING
  // ----------------------------------------------------------
  function addMessage(who, html, opts) {
    opts = opts || {};
    var wrap = document.createElement('div');
    wrap.className = 'msg ' + who;

    var bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.innerHTML = html;
    wrap.appendChild(bubble);

    if (!opts.noTime) {
      var t = document.createElement('div');
      t.className = 'msg-time';
      t.textContent = timeNow();
      wrap.appendChild(t);
    }

    $('chatMessages').appendChild(wrap);
    scrollDown();
    return wrap;
  }

  // Render soft buttons from the server. `reply` chips send their label as a
  // message (and clear the row on tap); action buttons dispatch and persist so
  // the customer can, e.g., both email and download a quote.
  function renderButtons(buttons) {
    if (!buttons || !buttons.length) return null;
    var row = document.createElement('div');
    row.className = 'chat-options';
    buttons.forEach(function (btn) {
      var isAction = btn.action && btn.action !== 'reply';
      var b = document.createElement('button');
      b.className = 'chat-option' + (isAction ? ' chat-option-quote' : '');
      b.textContent = btn.label;
      b.onclick = function () {
        if (btn.action === 'reply') { row.remove(); send(btn.label); }
        else dispatchAction(btn.action);
      };
      row.appendChild(b);
    });
    $('chatMessages').appendChild(row);
    scrollDown();
    return row;
  }

  function dispatchAction(action) {
    if (action === 'call_issam') { window.location.href = 'tel:' + BUSINESS.tel; return; }
    if (action === 'new_quote') { startNewQuote(); return; }
    if (action === 'view_pdf') {
      if (lastQuote) downloadQuotePdf(lastQuote);
      else addMessage('bot', '<p>Let’s finish your estimate first, then I can make the PDF.</p>');
      return;
    }
    if (action === 'email_quote') {
      if (lastQuote) askForEmail('What email should I send the quote to?', emailQuote);
      else addMessage('bot', '<p>Once we’ve got your estimate, I can email it to you.</p>');
      return;
    }
    if (action === 'email_issam') {
      askForEmail('What’s the best email for Issam to reach you? I’ll pass along your details.', sendLead);
      return;
    }
  }

  function showTyping() {
    var w = document.createElement('div');
    w.className = 'msg bot';
    w.id = 'typingIndicator';
    w.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
    $('chatMessages').appendChild(w);
    scrollDown();
  }
  function hideTyping() {
    var t = $('typingIndicator');
    if (t) t.remove();
  }

  function botError(msg) {
    addMessage('bot', '<p>' + msg + ' Call or text Issam at <a href="tel:' +
      BUSINESS.tel + '">' + BUSINESS.phone + '</a>.</p>');
  }

  // ----------------------------------------------------------
  // SEND + STREAM
  // ----------------------------------------------------------
  function send(text) {
    if (busy || !text || !text.trim()) return;
    text = text.trim();
    busy = true;

    addMessage('user', escapeHtml(text));
    history.push({ role: 'user', content: text });
    if (history.length > 20) history = history.slice(-20);

    var input = $('chatTextInput');
    if (input) input.value = '';

    showTyping();
    streamChat(text);
  }

  function streamChat(text) {
    var previewBubble = null;
    var acc = '';
    var finished = false;

    function ensurePreview() {
      if (previewBubble) return;
      hideTyping();
      var wrap = addMessage('bot', '', { noTime: true });
      previewBubble = wrap.querySelector('.msg-bubble');
      previewBubble.style.whiteSpace = 'pre-wrap';
    }
    function removePreview() {
      if (previewBubble && previewBubble.parentNode) previewBubble.parentNode.remove();
      previewBubble = null;
    }

    function handleEvent(evt) {
      if (!evt || !evt.type) return;
      if (evt.type === 'delta') {
        ensurePreview();
        acc += evt.text || '';
        previewBubble.textContent = acc;
        scrollDown();
      } else if (evt.type === 'done') {
        finished = true;
        removePreview();
        var reply = evt.reply || acc;
        if (reply && reply.trim()) {
          addMessage('bot', renderMarkdown(reply));
          history.push({ role: 'assistant', content: reply });
        } else {
          botError('Sorry — something went wrong on my end.');
        }
        lastQuote = evt.quote || null;
        renderButtons(evt.buttons);
      } else if (evt.type === 'error') {
        finished = true;
        removePreview();
        botError('Sorry — something went wrong on my end.');
        console.error('Chat stream error:', evt.error);
      }
    }

    function dispatchLine(line) {
      var evt;
      try { evt = JSON.parse(line); }
      catch (e) { console.warn('Chat: skipping non-JSON line:', line); return; }
      try { handleEvent(evt); }
      catch (e) {
        console.error('Chat: handleEvent threw for event', evt, '\n', e && e.stack ? e.stack : e);
      }
    }

    fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, history: history.slice(0, -1) })
    })
      .then(function (resp) {
        if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);
        var reader = resp.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';

        function pump() {
          return reader.read().then(function (result) {
            if (result.done) {
              var last = buffer.trim();
              if (last) dispatchLine(last);
              if (!finished) { removePreview(); botError('The connection dropped.'); }
              busy = false;
              return;
            }
            buffer += decoder.decode(result.value, { stream: true });
            var idx;
            while ((idx = buffer.indexOf('\n')) >= 0) {
              var line = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 1);
              if (line.trim()) dispatchLine(line);
            }
            return pump();
          });
        }
        return pump();
      })
      .catch(function (err) {
        hideTyping();
        removePreview();
        busy = false;
        if (!finished) botError('I couldn\'t reach the server.');
        console.error('Chat fetch failed:', err);
      });
  }

  function startNewQuote() {
    history = [];
    lastQuote = null;
    addMessage('bot', '<p>Sure — let’s start fresh. What would you like painted or restored?</p>');
    renderButtons(STARTER_BUTTONS);
  }

  // ----------------------------------------------------------
  // EMAIL (quote to customer, or lead to Issam)
  // ----------------------------------------------------------
  function askForEmail(promptText, onSubmit) {
    addMessage('bot', '<p>' + escapeHtml(promptText) + '</p>');

    var row = document.createElement('div');
    row.className = 'chat-options';
    row.style.width = '100%';

    var input = document.createElement('input');
    input.type = 'email';
    input.className = 'chat-input';
    input.placeholder = 'you@email.com';
    input.style.flex = '1';

    var btn = document.createElement('button');
    btn.className = 'chat-option chat-option-quote';
    btn.textContent = 'Send';

    function go() {
      var addr = input.value.trim();
      if (!addr || addr.indexOf('@') < 0) { input.focus(); return; }
      row.remove();
      addMessage('user', escapeHtml(addr));
      onSubmit(addr);
    }
    btn.onclick = go;
    input.onkeydown = function (e) { if (e.key === 'Enter') go(); };

    row.appendChild(input);
    row.appendChild(btn);
    $('chatMessages').appendChild(row);
    input.focus();
    scrollDown();
  }

  function money(low, high) {
    return low === high ? '$' + low : '$' + low + ' – $' + high;
  }

  function quoteLinesText(q) {
    return (q.line_items || []).map(function (li) {
      var line = '  • ' + li.description + ': ' + money(li.low, li.high) +
        (li.note ? ' (' + li.note + ')' : '');
      if (li.detail) line += '\n      ' + li.detail;
      return line;
    }).join('\n\n');
  }

  // Send a copy of a chat email to the owner's inbox (works around EmailJS
  // free-plan Cc/Bcc being dropped). Fire-and-forget.
  function emailCopyToOwner(serviceLabel, body) {
    if (!OWNER_COPY_EMAIL) return;
    try {
      emailjs.send(EMAILJS_SERVICE, EMAILJS_QUOTE_TEMPLATE, {
        name: 'Owner copy',
        email: OWNER_COPY_EMAIL,
        customer_email: OWNER_COPY_EMAIL,
        phone: 'Not provided',
        service: serviceLabel,
        message: '[Copy for your records]\n\n' + body
      }).catch(function () {});
    } catch (e) { /* non-fatal */ }
  }

  // Fire-and-forget: tell the server to text Issam that an email went out.
  // Server sends the SMS via Telnyx (dormant until configured in Railway).
  function notifySms(kind, to, total) {
    try {
      fetch('/notify-sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: kind, to: to, total: total || '' })
      }).catch(function () {});
    } catch (e) { /* non-fatal */ }
  }

  function emailQuote(address) {
    if (!lastQuote) return;
    var q = lastQuote;
    var total = money(q.total_low, q.total_high);

    var extras = '';
    if (q.minimum_applied) extras += 'Our $350 minimum job charge applies, so the low end reflects that.\n\n';
    if (q.has_door) extras += 'Door refinishing spans two visits — the enamel needs an overnight cure between coats. The return visit to rehang the door and reinstall the hardware is included.\n\n';

    var body =
      'Preliminary estimate from ' + BUSINESS.name + '\n\n' +
      quoteLinesText(q) + '\n\n' +
      'TOTAL: ' + total + '\n\n' +
      extras +
      'Payment: 30% deposit to schedule your job; the remaining 70% is due on completion.\n\n' +
      'This is a preliminary range. The final price is confirmed after Issam sees the work in person, and it does not change once agreed.\n\n' +
      BUSINESS.name + ' | ' + BUSINESS.phone + ' | ' + BUSINESS.site;

    emailjs.send(EMAILJS_SERVICE, EMAILJS_QUOTE_TEMPLATE, {
      name: 'Website chat visitor',
      email: address,
      customer_email: address,
      phone: 'Not provided',
      service: 'Chat estimate — ' + total,
      message: body
    }).then(function () {
      notifySms('quote', address, total);
      emailCopyToOwner('Chat estimate — ' + total, body);
      addMessage('bot', '<p>Sent. Check your inbox — and your spam folder just in case.</p>' +
        '<p>Issam will follow up shortly. You can reach him directly at <a href="tel:' +
        BUSINESS.tel + '">' + BUSINESS.phone + '</a>.</p>');
    }).catch(function (err) {
      console.error('EmailJS error:', err);
      addMessage('bot', '<p>That didn\'t go through. Text Issam at <a href="tel:' +
        BUSINESS.tel + '">' + BUSINESS.phone + '</a> and he\'ll send it over.</p>');
    });
  }

  function sendLead(address) {
    var ctx = '';
    if (lastQuote) {
      ctx = 'Preliminary estimate discussed: ' + money(lastQuote.total_low, lastQuote.total_high) + '\n' +
        quoteLinesText(lastQuote) + '\n\n';
    }
    var convo = history.slice(-8).map(function (m) {
      return (m.role === 'user' ? 'Customer' : 'Assistant') + ': ' + m.content;
    }).join('\n');

    var body =
      'A website chat visitor would like you to reach out.\n\n' +
      'Their email: ' + address + '\n\n' +
      ctx +
      'Recent conversation:\n' + convo;

    emailjs.send(EMAILJS_SERVICE, EMAILJS_LEAD_TEMPLATE, {
      name: 'Website chat visitor',
      email: address,
      customer_email: address,
      phone: 'Not provided',
      service: 'Chat lead — visitor wants a callback',
      message: body
    }).then(function () {
      notifySms('lead', address, lastQuote ? money(lastQuote.total_low, lastQuote.total_high) : '');
      emailCopyToOwner('Chat lead — callback request', body);
      addMessage('bot', '<p>Got it — I\'ve passed your details to Issam. He\'ll reach out soon. ' +
        'You can also call or text him at <a href="tel:' + BUSINESS.tel + '">' + BUSINESS.phone + '</a>.</p>');
    }).catch(function (err) {
      console.error('EmailJS lead error:', err);
      addMessage('bot', '<p>That didn\'t go through — please call or text Issam directly at <a href="tel:' +
        BUSINESS.tel + '">' + BUSINESS.phone + '</a>.</p>');
    });
  }

  // ----------------------------------------------------------
  // PDF — built entirely from the structured quote (no prose parsing)
  // ----------------------------------------------------------
  function downloadQuotePdf(q) {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      addMessage('bot', '<p>PDF isn\'t available in this browser — try the email option.</p>');
      return;
    }
    var doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'letter' });
    var M = 56, y = 60, W = 612, CW = W - M * 2, PAGE_BOTTOM = 740;
    function ensureSpace(h) { if (y + h > PAGE_BOTTOM) { doc.addPage(); y = 60; } }

    // Letterhead
    doc.setFont('helvetica', 'bold').setFontSize(17).setTextColor(31, 59, 87);
    doc.text(BUSINESS.name.toUpperCase(), M, y);
    y += 15;
    doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(107, 114, 128);
    doc.text('Repair & Refinish  |  Greater Orlando, FL', M, y);
    y += 12;
    doc.text(BUSINESS.addr + '   ' + BUSINESS.phone, M, y);

    doc.setFont('helvetica', 'bold').setFontSize(15).setTextColor(46, 125, 138);
    doc.text('PRELIMINARY ESTIMATE', W - M, 60, { align: 'right' });
    doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(107, 114, 128);
    doc.text(new Date().toLocaleDateString(), W - M, 75, { align: 'right' });

    y += 18;
    doc.setDrawColor(31, 59, 87).setLineWidth(2).line(M, y, W - M, y);
    y += 26;

    // Line items — description (with cost), then a "what's included" detail.
    (q.line_items || []).forEach(function (li) {
      var cost = money(li.low, li.high);
      ensureSpace(26);
      var dl = doc.splitTextToSize(li.description, CW - 120);
      doc.setFont('helvetica', 'bold').setFontSize(10.5).setTextColor(31, 59, 87).text(dl, M, y);
      doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(46, 92, 63).text(cost, W - M, y, { align: 'right' });
      y += dl.length * 13 + 2;

      var extra = (li.detail || '') + (li.note ? ' ' + li.note : '');
      if (extra.trim()) {
        ensureSpace(14);
        var el = doc.splitTextToSize(extra.trim(), CW);
        doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(110, 110, 110).text(el, M, y);
        y += el.length * 11;
      }
      y += 8;
      doc.setDrawColor(224, 228, 224).setLineWidth(0.5).line(M, y - 4, W - M, y - 4);
    });

    // Total box
    y += 8;
    ensureSpace(44);
    doc.setFillColor(31, 59, 87).rect(M, y, CW, 30, 'F');
    doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(255, 255, 255).text('TOTAL', M + 12, y + 20);
    doc.setFontSize(13).text(money(q.total_low, q.total_high), W - M - 12, y + 20, { align: 'right' });
    y += 46;

    // Payment terms
    ensureSpace(24);
    doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(31, 59, 87).text('PAYMENT', M, y);
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(60, 60, 60);
    var payLines = doc.splitTextToSize('30% deposit to schedule your job; the remaining 70% is due on completion.', CW - 66);
    doc.text(payLines, M + 62, y);
    y += Math.max(payLines.length * 12, 12) + 12;

    // Notes
    var notes = [];
    if (q.minimum_applied) notes.push('Our $350 minimum job charge applies, so the low end reflects that.');
    if (q.has_door) notes.push('Door refinishing spans two visits — the enamel needs an overnight cure between coats. The return visit to rehang the door and reinstall the hardware is included.');
    notes.push('Preliminary range based on the information provided in chat. The final price is confirmed after Issam sees the work in person, and it does not change once agreed. Estimate valid 30 days.');

    doc.setFont('helvetica', 'italic').setFontSize(8.5).setTextColor(107, 114, 128);
    notes.forEach(function (n) {
      ensureSpace(28);
      var nl = doc.splitTextToSize(n, CW);
      doc.text(nl, M, y);
      y += nl.length * 11 + 8;
    });

    y += 4;
    ensureSpace(20);
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(0, 0, 0);
    doc.text('Questions? Call or text ' + BUSINESS.phone + '  |  ' + BUSINESS.site, M, y);

    doc.save('SHP-Estimate-' + new Date().toISOString().slice(0, 10) + '.pdf');
    addMessage('bot', '<p>Downloaded. Call or text Issam at <a href="tel:' +
      BUSINESS.tel + '">' + BUSINESS.phone + '</a> whenever you\'re ready to book.</p>');
  }

  // ----------------------------------------------------------
  // INPUT AREA
  // ----------------------------------------------------------
  function buildInput() {
    var area = $('chatInputArea');
    if (!area || area.dataset.built) return;
    area.dataset.built = '1';
    area.innerHTML =
      '<div class="chat-input-wrap">' +
      '  <input class="chat-input" id="chatTextInput" type="text" ' +
      '         placeholder="Type your message..." autocomplete="off">' +
      '  <button class="chat-send" id="chatSendBtn" aria-label="Send">' +
      '    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '      <line x1="22" y1="2" x2="11" y2="13"/>' +
      '      <polygon points="22 2 15 22 11 13 2 9 22 2"/>' +
      '    </svg>' +
      '  </button>' +
      '</div>';

    $('chatSendBtn').onclick = function () { send($('chatTextInput').value); };
    $('chatTextInput').onkeydown = function (e) {
      if (e.key === 'Enter') { e.preventDefault(); send(this.value); }
    };
  }

  // ----------------------------------------------------------
  // OPEN / CLOSE  (global — index.html calls these inline)
  // ----------------------------------------------------------
  window.openChat = function () {
    $('chatPopup').classList.add('active');
    if (window.innerWidth <= 480) $('chatOverlay').classList.add('active');
    var fab = $('chatFab'); if (fab) fab.style.display = 'none';
    buildInput();
    if (!started) {
      started = true;
      addMessage('bot', '<p>' + escapeHtml(GREETING) + '</p>');
      renderButtons(STARTER_BUTTONS);
    }
    var inp = $('chatTextInput');
    if (inp && window.innerWidth > 480) inp.focus();
  };

  window.closeChat = function () {
    $('chatPopup').classList.remove('active');
    $('chatOverlay').classList.remove('active');
    var fab = $('chatFab'); if (fab) fab.style.display = 'flex';
  };

  // Expose for debugging
  window.SHPChat = {
    send: send,
    renderMarkdown: renderMarkdown,
    getHistory: function () { return history.slice(); },
    getLastQuote: function () { return lastQuote; }
  };
})();
