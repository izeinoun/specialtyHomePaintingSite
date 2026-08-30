// ============================================================
// Specialty Home Painting — web server (Railway)
// Serves the static site from /public, the FAQ page, and the chatbot
// backend (POST /chat). The Anthropic API key stays server-side and is
// never exposed to the browser.
//
// Chat pipeline (see orchestrator.js):
//   extractor (JSON) -> deterministic pricer -> presenter (streamed).
// ============================================================
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { renderFaqPage } from './knowledge.js';
import {
  runExtractor,
  planReply,
  startPresenter,
  EXTRACTOR_MODEL,
  PRESENTER_MODEL,
} from './orchestrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
const PORT = process.env.PORT || 3000;

// Build the Anthropic client lazily from the current environment. Constructing
// at module load captured the key only as it was at process start; a
// request-time read is robust to platform variable-injection timing (and
// re-reads if the key is rotated). Cached once a valid key is seen.
let anthropic = null;
function getAnthropic() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!anthropic) anthropic = new Anthropic({ apiKey });
  return anthropic;
}

// ------------------------------------------------------------
// Telnyx SMS alerts — text Issam whenever a chat email is sent.
// Configure in Railway: TELNYX_API_KEY, TELNYX_FROM_NUMBER (an
// SMS-enabled Telnyx number, E.164), ALERT_SMS_TO (Issam's cell, E.164).
// Dormant/no-op until all three are set. Destination is fixed to
// ALERT_SMS_TO and the message is built server-side, so the public
// endpoint can only ever text Issam (rate-limited below).
// ------------------------------------------------------------
const smsConfigured = () =>
  process.env.TELNYX_API_KEY && process.env.TELNYX_FROM_NUMBER && process.env.ALERT_SMS_TO;

// Simple fixed-window rate limit to bound abuse/cost.
let smsWinStart = 0;
let smsWinCount = 0;
function smsAllowed() {
  const now = Date.now();
  if (now - smsWinStart > 60000) { smsWinStart = now; smsWinCount = 0; }
  if (smsWinCount >= 10) return false;
  smsWinCount += 1;
  return true;
}

function smsField(s, max) {
  return String(s || '').replace(/[\r\n]+/g, ' ').trim().slice(0, max || 80);
}

async function sendTelnyxSms(text) {
  const r = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.TELNYX_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.TELNYX_FROM_NUMBER,
      to: process.env.ALERT_SMS_TO,
      text,
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error('Telnyx ' + r.status + ': ' + body.slice(0, 300));
  }
}

// Health check (used by Railway + uptime checks). Also reports whether the
// running process can see its Telnyx SMS vars — booleans only, no secrets.
app.get('/healthz', (_req, res) => res.json({
  ok: true,
  sms: {
    key: Boolean(process.env.TELNYX_API_KEY),
    from: Boolean(process.env.TELNYX_FROM_NUMBER),
    to: Boolean(process.env.ALERT_SMS_TO),
  },
}));

// Public FAQ page — rendered from content/faqs.md (single source of truth,
// shared with the chatbot's answer layer). Edit the markdown + redeploy.
app.get('/faqs', (_req, res) => {
  try {
    res.set('Cache-Control', 'no-cache').type('html').send(renderFaqPage());
  } catch (err) {
    console.error('FAQ render error:', err);
    res.status(500).type('text').send('FAQ page unavailable.');
  }
});

app.use(express.json({ limit: '256kb' }));

// ------------------------------------------------------------
// POST /chat — { message, history } -> NDJSON stream of events:
//   {"type":"delta","text":"..."}                incremental reply text
//   {"type":"done","reply","quote","buttons"}    final reply + structured
//                                                quote (or null) + buttons
//   {"type":"error","error":"..."}               failure
//
// Per turn: extractor (JSON) -> pricer/planner -> presenter (streamed).
// The browser holds the conversation `history` and echoes it back, so the
// server stays stateless.
// ------------------------------------------------------------
app.post('/chat', async (req, res) => {
  const { message, history } = req.body || {};

  // Validate + config-check first, while we can still send a clean status code.
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ success: false, error: 'message is required' });
  }
  const client = getAnthropic();
  if (!client) {
    console.error('Chat error: ANTHROPIC_API_KEY not set at request time');
    return res.status(500).json({ success: false, error: 'Chat not configured' });
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering
  const write = (obj) => res.write(JSON.stringify(obj) + '\n');

  // Abort the presenter stream only on a genuine mid-stream client disconnect.
  let settled = false;
  let stream = null;
  res.on('close', () => {
    if (!settled && stream) stream.abort();
  });

  try {
    // ① extract structured params + intent, then ② price / plan (no streaming)
    const extraction = await runExtractor(client, { history, message });
    const plan = planReply(extraction);

    // ③ present — friendly reply, streamed token-by-token
    stream = startPresenter(client, { history, message, situation: plan.situation });
    let full = '';
    stream.on('text', (delta) => {
      full += delta;
      write({ type: 'delta', text: delta });
    });
    await stream.finalMessage();
    settled = true;

    write({ type: 'done', reply: full, quote: plan.quote, buttons: plan.buttons });
    res.end();
  } catch (err) {
    settled = true;
    if (res.writableEnded) return; // client aborted — nothing to send
    // Log the full error server-side (status + name + message) so the app log
    // is the source of truth for debugging; the visitor sees a generic message.
    const status = (err && (err.status || err.statusCode)) || '';
    console.error('Chat error:', status, err && err.name, err && err.message);
    write({ type: 'error', error: 'Chat request failed' });
    res.end();
  }
});

// ------------------------------------------------------------
// POST /notify-sms — texts Issam that a chat email was sent.
// Body: { kind: "quote"|"lead", to: <recipient email>, total?: <string> }
// The server composes the message and always sends to ALERT_SMS_TO.
// ------------------------------------------------------------
app.post('/notify-sms', async (req, res) => {
  if (!smsConfigured()) return res.json({ ok: false, skipped: 'sms not configured' });
  if (!smsAllowed()) return res.status(429).json({ ok: false, error: 'rate limited' });

  const { kind, to, total } = req.body || {};
  const who = smsField(to, 120);
  const amt = smsField(total, 40);

  let text;
  if (kind === 'lead') {
    text = 'Specialty Home Painting: new chat lead — ' + (who || 'a visitor') +
      ' wants a callback' + (amt ? ' (' + amt + ')' : '') + '.';
  } else {
    text = 'Specialty Home Painting: estimate emailed to ' + (who || 'a customer') +
      (amt ? ' — ' + amt : '') + '.';
  }

  try {
    await sendTelnyxSms(text);
    res.json({ ok: true });
  } catch (err) {
    console.error('SMS notify error:', err && err.message);
    res.status(502).json({ ok: false });
  }
});

// Static website. `extensions: ['html']` lets /privacy resolve to privacy.html.
// HTML is served no-cache (revalidate every load) so a deploy's fresh markup —
// and the versioned asset URLs it references — are picked up immediately.
// Other assets keep a 1h cache; bump the ?v= query when their contents change.
app.use(
  express.static(PUBLIC_DIR, {
    extensions: ['html'],
    maxAge: '1h',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

const server = app.listen(PORT, () => {
  console.log(
    `Specialty Home Painting site on :${PORT} (extractor: ${EXTRACTOR_MODEL}, presenter: ${PRESENTER_MODEL})`
  );
});

// Graceful shutdown so Railway redeploys don't log a scary SIGTERM/npm error.
process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down cleanly.');
  server.close(() => process.exit(0));
});
