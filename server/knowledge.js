// ============================================================
// Knowledge base — single source of truth for the FAQ content.
// content/faqs.md drives BOTH the public /faqs page AND (later) the
// chatbot's answer layer. Edit the markdown + redeploy to update facts;
// no code change needed.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAQ_PATH = path.join(__dirname, '..', 'content', 'faqs.md');

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// **bold** -> <strong> (run AFTER escaping — escaping doesn't touch '*').
function inlineBold(escaped) {
  return escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

// Answer block -> HTML (paragraphs + bullet lists).
function answerToHtml(lines) {
  const out = [];
  let para = [];
  let bullets = [];
  const flushPara = () => {
    if (para.length) { out.push('<p>' + inlineBold(escapeHtml(para.join(' '))) + '</p>'); para = []; }
  };
  const flushBullets = () => {
    if (bullets.length) {
      out.push('<ul>' + bullets.map((b) => '<li>' + inlineBold(escapeHtml(b)) + '</li>').join('') + '</ul>');
      bullets = [];
    }
  };
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) { flushPara(); flushBullets(); continue; }
    if (/^\*\s+/.test(t)) { flushPara(); bullets.push(t.replace(/^\*\s+/, '')); continue; }
    flushBullets();
    para.push(t);
  }
  flushPara();
  flushBullets();
  return out.join('');
}

// Answer block -> plain text (for JSON-LD and the chatbot KB).
function answerToText(lines) {
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^\*\s+/, '• ').replace(/\*\*/g, ''))
    .join('\n');
}

function parse(md) {
  const faqs = [];
  for (const block of md.split(/^\s*---\s*$/m)) {
    const lines = block.split('\n');
    const qi = lines.findIndex((l) => /^###\s+/.test(l.trim()));
    if (qi === -1) continue;
    const q = lines[qi]
      .trim()
      .replace(/^###\s+/, '')
      .replace(/\*\*/g, '')
      .replace(/^\d+\\?\.\s*/, '') // strip "1\. " / "1. "
      .trim();
    const answerLines = lines.slice(qi + 1);
    faqs.push({ q, answerHtml: answerToHtml(answerLines), answerText: answerToText(answerLines) });
  }
  return faqs;
}

let cache = null;
export function getFaqs() {
  if (!cache) cache = parse(fs.readFileSync(FAQ_PATH, 'utf8'));
  return cache;
}

// For the chatbot answer layer (later): topic-scoped facts. Matches FAQs whose
// question or answer contains any of the given keywords; falls back to all.
export function getFaqText(keywords) {
  const faqs = getFaqs();
  const kws = (keywords || []).map((k) => String(k).toLowerCase()).filter(Boolean);
  const picked = kws.length
    ? faqs.filter((f) => {
        const hay = (f.q + ' ' + f.answerText).toLowerCase();
        return kws.some((k) => hay.includes(k));
      })
    : faqs;
  const list = picked.length ? picked : faqs;
  return list.map((f) => 'Q: ' + f.q + '\nA: ' + f.answerText).join('\n\n');
}

// ------------------------------------------------------------
// Public FAQ page — rendered from the same source, styled to match
// the rest of the site, with FAQPage JSON-LD for search / AI.
// ------------------------------------------------------------
export function renderFaqPage() {
  const faqs = getFaqs();

  const items = faqs
    .map(
      (f) =>
        '<section class="faq-item"><h2>' + escapeHtml(f.q) + '</h2>' + f.answerHtml + '</section>'
    )
    .join('\n');

  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.answerText },
    })),
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-B4MTKS754B"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-B4MTKS754B');
</script>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/favicon.png">
<title>Painting &amp; Door Restoration FAQ — Specialty Home Painting, Orlando FL</title>
<meta name="description" content="Answers to common questions about door restoration, drywall repair, trim and specialty painting in Orlando, FL — surface prep, alkyd enamel, two-visit door refinishing, and how we work.">
<link rel="canonical" href="https://specialtyhomepainting.com/faqs">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --cream: #F7F4EF; --warm-white: #FDFCFA; --charcoal: #1C1C1A; --mid: #6B6860;
    --light: #B8B4AC; --accent: #2A5C3F; --accent-light: #EAF2ED;
    --border: rgba(28,28,26,0.10); --serif: 'DM Serif Display', Georgia, serif; --sans: 'DM Sans', sans-serif;
  }
  html { scroll-behavior: smooth; }
  body { font-family: var(--sans); background: var(--warm-white); color: var(--charcoal); font-size: 16px; line-height: 1.6; -webkit-font-smoothing: antialiased; }
  a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 4px; }
  nav { position: sticky; top: 0; z-index: 100; background: rgba(253,252,250,0.92); backdrop-filter: blur(12px); border-bottom: 1px solid var(--border); padding: 0 2rem; display: flex; align-items: center; justify-content: space-between; height: 60px; }
  .nav-brand { display: flex; align-items: center; gap: 10px; font-family: var(--serif); font-size: 18px; color: var(--charcoal); text-decoration: none; }
  .nav-brand img { height: 34px; width: 34px; display: block; }
  .footer-logo { height: 68px; width: auto; display: block; }
  .footer-meta { text-align: right; }
  .nav-links { display: flex; align-items: center; gap: 2rem; list-style: none; }
  .nav-links a { font-size: 13px; color: var(--mid); text-decoration: none; transition: color 0.2s; }
  .nav-links a:hover { color: var(--charcoal); }
  .nav-links a.current { color: var(--charcoal); }
  .nav-cta { background: var(--accent) !important; color: #fff !important; padding: 8px 20px; border-radius: 100px; font-size: 13px !important; font-weight: 500 !important; }
  .nav-toggle { display: none; background: none; border: 0; cursor: pointer; padding: 6px; margin: -6px; color: var(--charcoal); }
  .nav-toggle svg { width: 24px; height: 24px; display: block; }
  .page-head { max-width: 820px; margin: 0 auto; padding: 5rem 2rem 2.5rem; }
  .page-eyebrow { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase; color: var(--accent); margin-bottom: 1.25rem; }
  .page-eyebrow::before { content: ''; display: inline-block; width: 24px; height: 1px; background: var(--accent); }
  .page-head h1 { font-family: var(--serif); font-size: clamp(32px, 5vw, 50px); line-height: 1.1; letter-spacing: -0.02em; margin-bottom: 1.25rem; }
  .page-head .lead { font-size: 17px; color: var(--charcoal); font-weight: 300; line-height: 1.75; max-width: 640px; }
  .divider { border: none; border-top: 1px solid var(--border); margin: 0 2rem; }
  main { max-width: 820px; margin: 0 auto; padding: 1rem 2rem 4rem; }
  .faq-item { padding: 2.25rem 0; border-bottom: 1px solid var(--border); }
  .faq-item:last-child { border-bottom: none; }
  .faq-item h2 { font-family: var(--serif); font-size: clamp(20px, 2.6vw, 26px); line-height: 1.25; letter-spacing: -0.01em; margin-bottom: 1rem; }
  .faq-item p { font-size: 16px; color: var(--mid); line-height: 1.8; font-weight: 300; margin-bottom: 1rem; }
  .faq-item p:last-child { margin-bottom: 0; }
  .faq-item strong { font-weight: 500; color: var(--charcoal); }
  .faq-item ul { margin: 0 0 1rem; padding-left: 1.2rem; }
  .faq-item li { font-size: 16px; color: var(--mid); font-weight: 300; margin-bottom: 0.35rem; }
  .cta { background: var(--cream); border-top: 1px solid var(--border); padding: 4rem 2rem; text-align: center; }
  .cta h2 { font-family: var(--serif); font-size: clamp(26px, 3.5vw, 36px); letter-spacing: -0.02em; margin-bottom: 0.75rem; }
  .cta p { font-size: 15px; color: var(--mid); font-weight: 300; margin-bottom: 2rem; }
  .btn-primary { background: var(--charcoal); color: #fff; padding: 14px 28px; border-radius: 100px; font-size: 14px; font-weight: 500; text-decoration: none; transition: background 0.2s; display: inline-block; }
  .btn-primary:hover { background: var(--accent); }
  footer { padding: 1.5rem 2rem; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem; max-width: 1100px; margin: 0 auto; }
  footer p { font-size: 12px; color: var(--light); }
  @media (max-width: 768px) {
    .nav-toggle { display: block; }
    .nav-links {
      display: none; position: absolute; top: 60px; left: 0; right: 0;
      flex-direction: column; align-items: stretch; gap: 0;
      background: var(--warm-white); border-bottom: 1px solid var(--border);
      padding: 6px 1.5rem 14px; box-shadow: 0 8px 20px rgba(0,0,0,0.06);
    }
    nav.nav-open .nav-links { display: flex; }
    .nav-links li { width: 100%; }
    .nav-links a { display: block; padding: 12px 2px; font-size: 15px; border-bottom: 1px solid var(--border); }
    .nav-links li:last-child a { border-bottom: 0; }
    .nav-cta { display: inline-block; margin-top: 10px; text-align: center; }
    .page-head { padding: 3rem 1.5rem 2rem; }
    main { padding: 0.5rem 1.5rem 3rem; }
    .cta { padding: 3rem 1.5rem; }
  }
  @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } * { transition: none !important; } }
</style>
</head>
<body>

<nav>
  <a href="/index.html" class="nav-brand"><img src="/favicon.png" alt="Specialty Home Painting logo">Specialty Home Painting</a>
  <button class="nav-toggle" aria-label="Menu" aria-expanded="false">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
  </button>
  <ul class="nav-links">
    <li><a href="/index.html#services">Services</a></li>
    <li><a href="/pricing.html">Pricing</a></li>
    <li><a href="/faqs" class="current">FAQ</a></li>
    <li><a href="/index.html#gallery">Gallery</a></li>
    <li><a href="/lessons.html">Lessons</a></li>
    <li><a href="/index.html#contact" class="nav-cta">Get a free estimate</a></li>
  </ul>
</nav>

<header class="page-head">
  <div class="page-eyebrow">FAQ</div>
  <h1>Painting &amp; door restoration questions</h1>
  <p class="lead">Straight answers about how we work — surface repair before paint, specialty door refinishing, detailed trim, and what to expect from a one-person specialty painting business in the greater Orlando area.</p>
</header>

<hr class="divider">

<main>
${items}
</main>

<div class="cta">
  <h2>Still have a question?</h2>
  <p>Call or text Issam directly, or get a free estimate — no obligation.</p>
  <a href="/index.html#contact" class="btn-primary">Get a free estimate</a>
</div>

<footer>
  <img src="/logo.png" alt="Specialty Home Painting" class="footer-logo">
  <div class="footer-meta">
    <p>© 2025 Specialty Home Painting — Orlando, FL</p>
    <p>Licensed &amp; insured · Registered Florida business</p>
  </div>
</footer>

<script type="application/ld+json">
${jsonLd}
</script>

<script>
(function () {
  var nav = document.querySelector('nav');
  if (!nav) return;
  var t = nav.querySelector('.nav-toggle');
  if (t) t.addEventListener('click', function () {
    var open = nav.classList.toggle('nav-open');
    t.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  nav.querySelectorAll('.nav-links a').forEach(function (a) {
    a.addEventListener('click', function () {
      nav.classList.remove('nav-open');
      if (t) t.setAttribute('aria-expanded', 'false');
    });
  });
})();
</script>
</body>
</html>`;
}
