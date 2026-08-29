// ============================================================
// Specialty Home Painting — web server (Railway)
// Serves the static site from /public and hosts the chatbot
// backend (POST /chat). The Anthropic API key stays server-side
// and is never exposed to the browser.
// ============================================================
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
const PORT = process.env.PORT || 3000;

// Chat customer volume is high, so a fast model is the deliberate default.
// Override with ANTHROPIC_MODEL in Railway if you want a more capable one.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

// ------------------------------------------------------------
// SYSTEM PROMPT — business rules + pricing.
// Ported from the old Google Apps Script chat proxy so pricing
// lives in one place, in this repo, under version control.
// ------------------------------------------------------------
const CHAT_SYSTEM_PROMPT = `You are a friendly chat assistant for Specialty Home Painting in Orlando, FL.
Owner: Issam | Phone: (904) 514-7016 | Website: specialtyhomepainting.com

SERVICES:
- Interior painting (walls, ceilings, trim, baseboards)
- Door restoration (repair, refinish, enamel finish)
- Drywall repair — minor patches included in room price. Damage larger than 1 inch priced separately after photos.
- Pre-sale home prep | Property manager turnover

PRICING:
Interior Painting per room:
- Small: Good $150-180, Fair $200-240, Bad $275-330
- Medium: Good $250-300, Fair $325-390, Bad $425-510
- Large: Good $400-480, Fair $500-600, Bad $650-780
Ceiling add-on: Small +$75-90, Medium +$100-120, Large +$150-180
Trim add-on: Small +$50-60, Medium +$75-90, Large +$100-120

Door Restoration — INTERIOR doors, per door:
- Good (light scuffs, scuff-sand + 2 coats): $120-150
- Fair (scratches, minor chips — fill, sand, prime, 2 coats): $160-200
- Bad (peeling, gouges, real repair first): $220-280

Door Restoration — EXTERIOR / FRONT ENTRY doors, per door:
- On-site restoration (scratch repair, peel prep, prime, two coats alkyd enamel): $500-800
- Oversized doors, or doors with a sidelight, price toward the top of that range
- Never quote an exterior or front entry door off the interior matrix — different job entirely

Drywall >1 inch: $75-400 after photo review

MINIMUM JOB CHARGE — $350:
- Every job carries a $350 minimum no matter how the line items add up.
- If the low end of the total falls below $350, raise the low end to $350 and leave the high end
  as calculated. Example: 2 fair interior doors calculates to $320-400, presented as $350-400.
- Say it once, plainly, no apology: "Our minimum job charge is $350, so that's where this lands."

DOOR CURE TIME — include on every estimate containing a door:
Door refinishing spans two visits — the enamel needs an overnight cure between coats. Doors are
rehung and hardware reinstalled on the return visit, and that return trip is included in the price.
Never describe a door job as "a few hours" or as same-day work.

SMART ASSUMPTIONS — always state these clearly:
- Bedrooms = medium size unless stated
- No mention of ceiling = not included
- No mention of trim = not included

NEVER ASSUME on interior vs exterior doors — the prices are far apart. If it is not clear which
one the customer means, ask before quoting: "Quick check — interior doors, or a front entry /
exterior door?" Do not quote a range that spans both.

CONVERSATION RULES:
- Keep responses SHORT — chat widget not email
- Ask 2-3 questions at a time
- Use markdown freely — bold, tables, bullets all render correctly
- Never mention you are an AI
- For calls: say "Call or text Issam at (904) 514-7016"

QUICK BUTTONS — suggest when helpful using EXACTLY this format on its own line:
[BUTTONS: option1 | option2 | option3]

ESTIMATE INSTRUCTIONS — CRITICAL:
When you have enough info to calculate an estimate, ALWAYS start your response with exactly this phrase on its own line:
Generated Preliminary Estimate

Then provide the estimate in your natural style using markdown — bold, bullets, tables are all fine.
Always include a total range at the end, with the $350 minimum applied if it applies.
If the estimate includes a door, include the two-visit cure time line.
After the estimate ask: "Would you like to download this as a PDF or have it emailed to you?"`;

// Build the client lazily from the current environment. Constructing at module
// load captured the key only as it was at process start; a request-time read is
// robust to platform variable-injection timing (and re-reads if the key is
// rotated). The client is cached once a valid key is seen.
let anthropic = null;
function getAnthropic() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!anthropic) anthropic = new Anthropic({ apiKey });
  return anthropic;
}

// ------------------------------------------------------------
// PROCESS REPLY — detect the estimate trigger phrase and convert
// it to the store_quote action the chat widget renders with the
// PDF / email / call buttons. Otherwise return the text as-is.
// ------------------------------------------------------------
function processReply(reply) {
  const trimmed = reply.trim();

  // Already a JSON action — pass through.
  if (trimmed.startsWith('{') && trimmed.includes('"action"')) {
    return reply;
  }

  if (trimmed.startsWith('Generated Preliminary Estimate')) {
    const summary = trimmed.replace('Generated Preliminary Estimate', '').trim();
    return JSON.stringify({
      action: 'store_quote',
      data: { summary, items: [], total_low: 0, total_high: 0 },
    });
  }

  return reply;
}

// Health check (used by Railway + uptime checks)
app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.use(express.json({ limit: '256kb' }));

// ------------------------------------------------------------
// POST /chat — { message, history } -> NDJSON stream of events:
//   {"type":"delta","text":"..."}   incremental assistant text
//   {"type":"done","reply":"..."}    final reply (post-processed)
//   {"type":"error","error":"..."}   failure (may arrive mid-stream)
//
// The client renders deltas as a live preview, then does the
// definitive render (estimate buttons, markdown) from `done.reply`.
// history is an array of prior { role, content } turns.
// ------------------------------------------------------------
app.post('/chat', async (req, res) => {
  const { message, history } = req.body || {};

  // Validate before opening the stream so we can still send a clean 400.
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ success: false, error: 'message is required' });
  }

  // Keep only well-formed prior turns; cap history to bound token cost.
  const priorTurns = Array.isArray(history)
    ? history
        .filter(
          (m) =>
            m &&
            (m.role === 'user' || m.role === 'assistant') &&
            typeof m.content === 'string'
        )
        .slice(-10)
    : [];

  const messages = [...priorTurns, { role: 'user', content: message }];

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering

  const write = (obj) => res.write(JSON.stringify(obj) + '\n');

  const client = getAnthropic();
  if (!client) {
    console.error('Chat error: ANTHROPIC_API_KEY not set at request time');
    write({ type: 'error', error: 'Chat request failed', reason: 'ANTHROPIC_API_KEY missing' });
    return res.end();
  }

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 600,
    system: CHAT_SYSTEM_PROMPT,
    messages,
  });

  // Stop generating (and stop billing) only on a *genuine* client disconnect
  // mid-stream. We watch the RESPONSE, not the request: on Node the request
  // emits 'close' as soon as its body is consumed (before we finish streaming),
  // which previously aborted every reply. The `settled` guard ensures we never
  // abort once the reply has completed normally.
  let settled = false;
  res.on('close', () => {
    if (!settled) stream.abort();
  });

  try {
    let full = '';
    stream.on('text', (delta) => {
      full += delta;
      write({ type: 'delta', text: delta });
    });

    await stream.finalMessage();
    settled = true;

    write({ type: 'done', reply: processReply(full) });
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

app.listen(PORT, () => {
  console.log(`Specialty Home Painting site listening on :${PORT} (model: ${MODEL})`);
});
