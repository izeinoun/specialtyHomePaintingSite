// ============================================================
// Specialty Home Painting — web server (Railway)
// Phase 2: serves the static site from /public.
// Phase 3 will add the streaming POST /chat endpoint.
// ============================================================
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
const PORT = process.env.PORT || 3000;

// Health check (used by Railway + uptime checks)
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Static website. `extensions: ['html']` lets /privacy resolve to privacy.html.
app.use(
  express.static(PUBLIC_DIR, {
    extensions: ['html'],
    maxAge: '1h',
  })
);

app.listen(PORT, () => {
  console.log(`Specialty Home Painting site listening on :${PORT}`);
});
