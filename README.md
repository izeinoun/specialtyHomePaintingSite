# Specialty Home Painting — Website + Chatbot

Static marketing site plus a Node.js backend, hosted on **Railway**. A single
service serves both the website (`/public`) and a `/chat` API for the customer
chatbot, which calls the Anthropic API server-side (key never reaches the
browser).

## Structure

```
public/          Static site (HTML, images, chat.js) — served as-is
server/
  index.js       Express server: serves /public, health check, POST /chat
                 (system prompt + pricing live here)
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

## Chat API

`POST /chat` — request `{ "message": string, "history": [{role, content}, ...] }`,
response `{ "success": true, "reply": string }`. The reply is either markdown text
or, when the assistant produces an estimate, a `store_quote` action JSON that the
widget renders with PDF / email / call buttons. The system prompt (including all
pricing) lives in `server/index.js`.

## Migration status

- **Static site:** served from Railway.
- **Chatbot:** now served by this app's own `POST /chat` endpoint (Anthropic API,
  server-side key). The legacy Google Apps Script chat proxy is retired. Quote
  logging still posts to a separate Apps Script Sheets webhook (`QUOTE_SHEETS_URL`
  in `public/chat.js`) — migrate that too if you want it off Apps Script.

### Possible follow-up

- Stream `/chat` responses (SSE) for faster perceived latency. The widget
  currently consumes a single JSON reply, so streaming would require frontend
  changes to the estimate/button parsing.
