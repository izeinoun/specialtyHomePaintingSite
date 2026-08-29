// ============================================================
// SPECIALTY HOME PAINTING — CHAT WIDGET
// Drop-in replacement for chat.js
// Rev. August 2026
//
// Fixes:
//   - Markdown tables now render (was stripping | and --- into %%%%%)
//   - store_quote payload parsed for real line items and totals
//   - Estimate disclaimer + closing line no longer stripped
//   - XSS-safe: all model output is escaped before formatting
//
// Requires (already in index.html):
//   - jsPDF  ................ window.jspdf
//   - EmailJS ............... window.emailjs, already init()'d
//   - #chatFab #chatOverlay #chatPopup #chatMessages #chatInputArea
// ============================================================

(function () {
  'use strict';

  // ----------------------------------------------------------
  // CONFIG — chat now runs on our own Railway server (same origin).
  // ----------------------------------------------------------
  var CHAT_PROXY_URL = '/chat';
  var QUOTE_SHEETS_URL = 'https://script.google.com/macros/s/AKfycbwW4JaSlvo28cA2AjVDvCgUZX5aFUxoW6DSX0qndfN_Jm2VmSEcqWzbM_KPzadVw6G2/exec';

  var EMAILJS_SERVICE  = 'service_s9zggu9';
  var EMAILJS_TEMPLATE = 'template_yrs9zfk';

  var BUSINESS = {
    name:  'Specialty Home Painting',
    phone: '(904) 514-7016',
    tel:   '9045147016',
    email: 'issam@specialtyhomepainting.com',
    site:  'specialtyhomepainting.com',
    addr:  '14370 Sapelo Beach Dr., Orlando, FL 32827'
  };

  var GREETING = "Hi! I can put together a rough estimate for you right here. What are you looking to have done?";
  var STARTERS = ['Door restoration', 'Interior painting', 'Drywall repair', 'Something else'];

  // ----------------------------------------------------------
  // STATE
  // ----------------------------------------------------------
  var history = [];        // [{role, content}] sent to the API
  var lastQuote = null;    // most recent store_quote data object
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
    // Estimate table — rendered as a compact definition list, not a real table.
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
  // MARKDOWN -> HTML
  // Handles: tables, bold, italic, bullets, hr, headings, links.
  // Everything is escaped first, so model output can never inject HTML.
  // ----------------------------------------------------------
  function inlineMd(text) {
    return escapeHtml(text)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  function isTableRow(line) {
    return line.trim().charAt(0) === '|';
  }

  function isTableSeparator(line) {
    return /^\|[\s\-:|]+\|?\s*$/.test(line.trim());
  }

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

      // --- blank
      if (t === '') { i++; continue; }

      // --- horizontal rule
      if (/^-{3,}$/.test(t) || /^_{3,}$/.test(t) || /^\*{3,}$/.test(t)) {
        out.push('<hr>');
        i++;
        continue;
      }

      // --- table block
      if (isTableRow(t)) {
        var rows = [];
        while (i < lines.length && isTableRow(lines[i].trim())) {
          if (!isTableSeparator(lines[i])) rows.push(splitRow(lines[i]));
          i++;
        }
        if (rows.length) {
          // Drop a header row that is literally Item / Cost
          if (rows.length > 1 &&
              /^item$/i.test(rows[0][0] || '') &&
              /^cost$/i.test(rows[0][1] || '')) {
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

      // --- Total line: **Total: $X – $Y**
      var totalMatch = t.match(/^\*\*\s*Total:?\s*(.+?)\s*\*\*$/i);
      if (totalMatch) {
        out.push('<div class="q-total">' +
                 '<span class="q-total-label">Total</span>' +
                 '<span class="q-total-value">' + escapeHtml(totalMatch[1]) + '</span></div>');
        i++;
        continue;
      }

      // --- bullet list
      if (/^[-*•]\s+/.test(t)) {
        var items = [];
        while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) {
          items.push('<li>' + inlineMd(lines[i].trim().replace(/^[-*•]\s+/, '')) + '</li>');
          i++;
        }
        out.push('<ul>' + items.join('') + '</ul>');
        continue;
      }

      // --- heading
      if (/^#{1,6}\s+/.test(t)) {
        out.push('<h4>' + inlineMd(t.replace(/^#{1,6}\s+/, '')) + '</h4>');
        i++;
        continue;
      }

      // --- standalone bold line acts as a small heading
      if (/^\*\*[^*]+\*\*$/.test(t)) {
        out.push('<h4>' + inlineMd(t.replace(/\*\*/g, '')) + '</h4>');
        i++;
        continue;
      }

      // --- italic-only line = the disclaimer
      if (/^\*[^*].*\*$/.test(t)) {
        out.push('<p class="q-note">' + inlineMd(t.replace(/^\*|\*$/g, '')) + '</p>');
        i++;
        continue;
      }

      // --- paragraph (collect until blank or structural line)
      var para = [];
      while (i < lines.length) {
        var pl = lines[i].trim();
        if (pl === '' || isTableRow(pl) || /^[-*•]\s+/.test(pl) ||
            /^-{3,}$/.test(pl) || /^#{1,6}\s+/.test(pl) ||
            /^\*\*\s*Total:?/i.test(pl)) break;
        para.push(pl);
        i++;
      }
      if (para.length) out.push('<p>' + inlineMd(para.join(' ')) + '</p>');
    }

    return out.join('');
  }

  // ----------------------------------------------------------
  // MESSAGE RENDERING
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

  function addButtons(labels, handler, extraClass) {
    var row = document.createElement('div');
    row.className = 'chat-options';
    labels.forEach(function (label) {
      var b = document.createElement('button');
      b.className = 'chat-option' + (extraClass ? ' ' + extraClass : '');
      b.textContent = label;
      b.onclick = function () {
        row.remove();
        handler(label);
      };
      row.appendChild(b);
    });
    $('chatMessages').appendChild(row);
    scrollDown();
    return row;
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

  // ----------------------------------------------------------
  // SEND
  // ----------------------------------------------------------
  function send(text) {
    if (busy || !text || !text.trim()) return;
    text = text.trim();
    busy = true;

    addMessage('user', escapeHtml(text));
    history.push({ role: 'user', content: text });
    if (history.length > 10) history = history.slice(-10);

    var input = $('chatTextInput');
    if (input) input.value = '';

    showTyping();

    streamChat(text);
  }

  // ----------------------------------------------------------
  // STREAMING
  // Reads an NDJSON stream ({type:delta|done|error}). Deltas render
  // as a plain-text live preview; the final formatted render (markdown,
  // estimate buttons, quote) happens once from the `done` reply.
  // ----------------------------------------------------------
  function cleanPreview(text) {
    return String(text)
      .replace(/^Generated Preliminary Estimate\s*/, '')
      .replace(/\[BUTTONS:[^\]]*\]?/i, '')
      .replace(/^\s+/, '');
  }

  function botError(msg) {
    addMessage('bot', '<p>' + msg + ' Call or text Issam at <a href="tel:' +
      BUSINESS.tel + '">' + BUSINESS.phone + '</a>.</p>');
  }

  function streamChat(text) {
    var previewBubble = null;   // live-updating bubble element
    var acc = '';               // accumulated raw text (for fallback)
    var finished = false;       // a done/error event was handled

    function ensurePreview() {
      if (previewBubble) return;
      hideTyping();
      var wrap = addMessage('bot', '', { noTime: true });
      previewBubble = wrap.querySelector('.msg-bubble');
      previewBubble.style.whiteSpace = 'pre-wrap';
      previewBubble.parentNode.dataset.preview = '1';
    }

    function removePreview() {
      if (previewBubble && previewBubble.parentNode) {
        previewBubble.parentNode.remove();
      }
      previewBubble = null;
    }

    function handleEvent(evt) {
      if (!evt || !evt.type) return;
      if (evt.type === 'delta') {
        ensurePreview();
        acc += evt.text || '';
        previewBubble.textContent = cleanPreview(acc);
        scrollDown();
      } else if (evt.type === 'done') {
        finished = true;
        removePreview();
        var reply = evt.reply || acc;
        if (reply && reply.trim()) {
          handleReply(reply);
        } else {
          botError('Sorry — something went wrong on my end.');
        }
      } else if (evt.type === 'error') {
        finished = true;
        removePreview();
        // TEMP DEBUG: surface the real reason in the bubble.
        var detail = evt.reason ? ' [' + escapeHtml(String(evt.reason)) + ']' : '';
        botError('Sorry — something went wrong on my end.' + detail);
        console.error('Chat stream error:', evt.error, evt.reason);
      }
    }

    // Parse one NDJSON line and dispatch it. JSON parse failures are skipped
    // (partial/garbage line); errors thrown INSIDE handleEvent are logged with
    // a full stack so the calling routine and line are visible — never swallowed.
    function dispatchLine(line) {
      var evt;
      try {
        evt = JSON.parse(line);
      } catch (parseErr) {
        console.warn('Chat: skipping non-JSON line:', line);
        return;
      }
      try {
        handleEvent(evt);
      } catch (handlerErr) {
        console.error(
          'Chat: handleEvent threw for event', evt, '\n',
          handlerErr && handlerErr.stack ? handlerErr.stack : handlerErr
        );
      }
    }

    fetch(CHAT_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, history: history.slice(0, -1) })
    })
      .then(function (resp) {
        if (!resp.ok || !resp.body) {
          throw new Error('HTTP ' + resp.status);
        }
        var reader = resp.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';

        function pump() {
          return reader.read().then(function (result) {
            if (result.done) {
              // flush any trailing line
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

  // ----------------------------------------------------------
  // REPLY HANDLING
  // ----------------------------------------------------------
  function handleReply(reply) {
    var trimmed = String(reply).trim();

    // store_quote action from the proxy
    if (trimmed.charAt(0) === '{') {
      var parsed = null;
      try { parsed = JSON.parse(trimmed); } catch (e) { parsed = null; }
      if (parsed && parsed.action === 'store_quote' && parsed.data) {
        renderQuote(parsed.data);
        history.push({ role: 'assistant', content: parsed.data.summary || trimmed });
        return;
      }
    }

    // Pull out [BUTTONS: a | b | c] before rendering
    var buttons = null;
    var body = trimmed.replace(/\[BUTTONS:\s*([^\]]+)\]/i, function (_, list) {
      buttons = list.split('|').map(function (s) { return s.trim(); })
                    .filter(function (s) { return s.length; });
      return '';
    }).trim();

    addMessage('bot', renderMarkdown(body));
    history.push({ role: 'assistant', content: trimmed });

    if (buttons && buttons.length) {
      addButtons(buttons, send);
    }
  }

  function renderQuote(data) {
    lastQuote = data;

    addMessage('bot', renderMarkdown(data.summary || ''));

    // Log the structured quote (fire and forget)
    try {
      var params = new URLSearchParams({
        source: 'Chat Quote',
        total_low: data.total_low || 0,
        total_high: data.total_high || 0,
        item_count: data.item_count || 0,
        below_minimum: data.below_minimum ? 'YES' : 'NO',
        items: JSON.stringify(data.items || []),
        summary: (data.summary || '').slice(0, 1500)
      });
      fetch(QUOTE_SHEETS_URL + '?' + params.toString()).catch(function () {});
    } catch (e) { /* non-fatal */ }

    addButtons(
      ['Email me this quote', 'Download PDF', 'Call Issam'],
      function (choice) {
        if (choice === 'Download PDF') downloadQuotePdf(data);
        else if (choice === 'Call Issam') window.location.href = 'tel:' + BUSINESS.tel;
        else askForEmail();
      },
      'chat-option-quote'
    );
  }

  // ----------------------------------------------------------
  // EMAIL THE QUOTE
  // ----------------------------------------------------------
  function askForEmail() {
    addMessage('bot', '<p>What email should I send it to?</p>');

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
      emailQuote(addr);
    }

    btn.onclick = go;
    input.onkeydown = function (e) { if (e.key === 'Enter') go(); };

    row.appendChild(input);
    row.appendChild(btn);
    $('chatMessages').appendChild(row);
    input.focus();
    scrollDown();
  }

  function emailQuote(address) {
    if (!lastQuote) return;

    var lines = (lastQuote.items || []).map(function (it) {
      var cost = it.low === it.high
        ? '$' + it.low
        : '$' + it.low + ' - $' + it.high;
      return '  • ' + it.description + ': ' + cost;
    }).join('\n');

    var total = lastQuote.total_low === lastQuote.total_high
      ? '$' + lastQuote.total_low
      : '$' + lastQuote.total_low + ' - $' + lastQuote.total_high;

    var body =
      'Preliminary estimate from ' + BUSINESS.name + '\n\n' +
      lines + '\n\n' +
      'TOTAL: ' + total + '\n\n' +
      '---\n' + (lastQuote.summary || '') + '\n---\n\n' +
      'This is a preliminary range. The final price is confirmed after Issam sees ' +
      'the work in person, and it does not change once agreed.\n\n' +
      BUSINESS.name + ' | ' + BUSINESS.phone + ' | ' + BUSINESS.site;

    emailjs.send(EMAILJS_SERVICE, EMAILJS_TEMPLATE, {
      name: 'Website chat visitor',
      email: address,
      customer_email: address,
      phone: 'Not provided',
      service: 'Chat estimate — ' + total,
      message: body
    }).then(function () {
      addMessage('bot', '<p>Sent. Check your inbox — and your spam folder just in case.</p>' +
        '<p>Issam will follow up shortly. You can reach him directly at <a href="tel:' +
        BUSINESS.tel + '">' + BUSINESS.phone + '</a>.</p>');
    }).catch(function (err) {
      console.error('EmailJS error:', err);
      addMessage('bot', '<p>That didn\'t go through. Text Issam at <a href="tel:' +
        BUSINESS.tel + '">' + BUSINESS.phone + '</a> and he\'ll send it over.</p>');
    });
  }

  // ----------------------------------------------------------
  // PDF
  // ----------------------------------------------------------
  function downloadQuotePdf(data) {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      addMessage('bot', '<p>PDF isn\'t available in this browser - try the email option.</p>');
      return;
    }
    var doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'letter' });
    var M = 56, y = 60, W = 612;

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
    y += 28;

    doc.setFontSize(9.5).setTextColor(0, 0, 0);
    (data.items || []).forEach(function (it) {
      var cost = it.low === it.high ? '$' + it.low : '$' + it.low + ' - $' + it.high;
      var desc = doc.splitTextToSize(it.description, W - M * 2 - 110);
      doc.setFont('helvetica', 'normal').text(desc, M, y);
      doc.setFont('helvetica', 'bold').text(cost, W - M, y, { align: 'right' });
      y += Math.max(desc.length * 12, 12) + 6;
      doc.setDrawColor(199, 208, 214).setLineWidth(0.5).line(M, y - 4, W - M, y - 4);
    });

    y += 10;
    var total = data.total_low === data.total_high
      ? '$' + data.total_low
      : '$' + data.total_low + ' - $' + data.total_high;
    doc.setFillColor(31, 59, 87).rect(M, y, W - M * 2, 30, 'F');
    doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(255, 255, 255);
    doc.text('TOTAL', M + 12, y + 20);
    doc.setFontSize(13).text(total, W - M - 12, y + 20, { align: 'right' });
    y += 52;

    doc.setFont('helvetica', 'italic').setFontSize(8.5).setTextColor(107, 114, 128);
    var note = doc.splitTextToSize(
      'Preliminary range based on the information provided in chat. The final price is confirmed ' +
      'after Issam sees the work in person, and it does not change once agreed. ' +
      'Minimum job charge $350. Estimate valid 30 days.', W - M * 2);
    doc.text(note, M, y);
    y += note.length * 11 + 16;

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
  // OPEN / CLOSE  (global - index.html calls these inline)
  // ----------------------------------------------------------
  window.openChat = function () {
    $('chatPopup').classList.add('active');
    if (window.innerWidth <= 480) $('chatOverlay').classList.add('active');
    var fab = $('chatFab'); if (fab) fab.style.display = 'none';
    buildInput();
    if (!started) {
      started = true;
      addMessage('bot', '<p>' + escapeHtml(GREETING) + '</p>');
      addButtons(STARTERS, send);
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
