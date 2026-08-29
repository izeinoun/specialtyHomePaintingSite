# Specialty Home Painting — Website + Chatbot

Static marketing site plus a Node.js backend, hosted on **Railway**. A single
service serves both the website (`/public`) and (from Phase 3) a streaming
`/chat` API for the customer chatbot.

## Structure

```
public/          Static site (HTML, images, chat.js) — served as-is
server/
  index.js       Express server: serves /public, health check, (Phase 3) /chat
package.json     Start script + Node engine
railway.json     Railway build/deploy config
.env.example     Documents required env vars (no secrets)
```

## Local development

```bash
npm install
cp .env.example .env      # then fill in ANTHROPIC_API_KEY
npm run dev               # http://localhost:3000
```

## Environment variables (set in Railway → Variables)

| Variable            | Purpose                                            |
|---------------------|----------------------------------------------------|
| `ANTHROPIC_API_KEY` | Anthropic API key — **server-side only**           |
| `ANTHROPIC_MODEL`   | Chat model (e.g. `claude-haiku-4-5-20251001`)      |
| `PORT`              | Supplied automatically by Railway in production    |

Never commit real secrets. `.env` is gitignored.

## Deploy (Railway)

1. `railway login`
2. `railway link` (or `railway init`) to connect this repo to a Railway project
3. Set the environment variables above in the Railway dashboard
4. Push to `main` — Railway builds with Nixpacks and runs `npm start`

## Migration status

- **Phase 2 (done):** static site served from Railway; chatbot still calls the
  legacy Google Apps Script proxy (unchanged, still working).
- **Phase 3 (planned):** replace Apps Script with a streaming `/chat` endpoint
  calling the Anthropic API directly. See migration plan.
