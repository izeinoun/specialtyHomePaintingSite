// ============================================================
// Deterministic quote calculator — the ONLY thing that computes money.
// Pure function: JSON params in, structured quote (or need_info / handoff)
// out. No LLM, no side effects. Fully unit-tested (pricing.test.js).
//
// Prices are ranges [low, high]. Numbers come from the Specialty Home
// Painting rate sheet; the LLM never invents them.
// ============================================================

export const MINIMUM = 350;

// Interior room, per room: size -> condition -> [low, high]
export const ROOM_RATES = {
  small:  { good: [150, 180], fair: [200, 240], bad: [275, 330] },
  medium: { good: [250, 300], fair: [325, 390], bad: [425, 510] },
  large:  { good: [400, 480], fair: [500, 600], bad: [650, 780] },
};

// Room add-ons, by size: [low, high]
export const CEILING_RATES = { small: [75, 90],  medium: [100, 120], large: [150, 180] };
export const TRIM_RATES    = { small: [50, 60],  medium: [75, 90],   large: [100, 120] };
export const CROWN_RATES   = { small: [70, 100], medium: [110, 150], large: [160, 220] };

// Interior door, per door: condition -> [low, high]
export const INTERIOR_DOOR_RATES = { good: [120, 150], fair: [160, 200], bad: [220, 280] };
// French interior doors are much slower (glass panes + muntins) — ~2x.
export const INTERIOR_FRENCH_DOOR_RATES = { good: [250, 320], fair: [340, 430], bad: [460, 580] };

// Exterior / front-entry door, per door
export const EXTERIOR_DOOR_BASE = [500, 800];
export const EXTERIOR_DOOR_TOP  = [650, 800]; // oversized or with a sidelight
export const EXTERIOR_FRENCH_DOOR = [900, 1300];

// Windows (woodwork + trim), per window: condition -> [low, high]
export const WINDOW_RATES = { good: [60, 90], fair: [90, 140], bad: [150, 220] };

// Banister / railing run (handrail, balusters, newel posts): condition -> [low, high]
export const RAILING_RATES = { good: [150, 225], fair: [250, 375], bad: [400, 575] };

const SIZES = ['small', 'medium', 'large'];
const CONDITIONS = ['good', 'fair', 'bad'];

function norm(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : v;
}
function qty(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}
function titadel(s) {
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}
function suf(n) {
  return n > 1 ? ' (×' + n + ')' : '';
}

const ROOM_DETAIL = {
  good: 'Light prep, spot-priming as needed, and two finish coats on the walls. Minor drywall patches included.',
  fair: 'Patching, sanding, and spot-priming to smooth out imperfections, then two finish coats. Minor drywall patches included.',
  bad: 'Heavier repair — filling, sanding, and feathering damaged areas into the wall — then priming and two finish coats. Minor drywall patches included.',
};
const INT_DOOR_DETAIL = {
  good: 'Scuff-sand and two coats for a clean, even finish; door rehung when dry.',
  fair: 'Fill scratches and minor chips, sand, prime, then two coats; door rehung when dry.',
  bad: 'Repair peeling, gouges, and damaged areas first, then prime and two coats; door rehung when dry.',
};
const WINDOW_DETAIL = {
  good: 'Light prep and two coats on the sash, frame, and casing.',
  fair: 'Fill, sand, and prime the woodwork, then two finish coats.',
  bad: 'Repair and heavy prep on damaged or peeling woodwork, then prime and two coats.',
};
const RAILING_DETAIL = {
  good: 'Scuff-sand the handrail, balusters, and newel posts, then two coats.',
  fair: 'Fill and sand the woodwork, prime, then two coats.',
  bad: 'Repair and strip failing finish first, then prime and two coats.',
};

// ------------------------------------------------------------
// calculateQuote(params) -> one of:
//   { status: 'need_info', missing: [{item, field, hint}] }
//   { status: 'handoff',   reasons: [string] }
//   { status: 'ok', line_items, subtotal_low, subtotal_high,
//                   minimum_applied, total_low, total_high, has_door }
// ------------------------------------------------------------
export function calculateQuote(params) {
  const p = params || {};
  const rooms = Array.isArray(p.rooms) ? p.rooms : [];
  const interiorDoors = Array.isArray(p.interior_doors) ? p.interior_doors : [];
  const exteriorDoors = Array.isArray(p.exterior_doors) ? p.exterior_doors : [];
  const windows = Array.isArray(p.windows) ? p.windows : [];
  const railings = Array.isArray(p.railings) ? p.railings : [];
  const outOfScope = Array.isArray(p.out_of_scope) ? p.out_of_scope : [];

  // Out-of-catalog work routes to Issam (per design decision).
  if (outOfScope.length) {
    return {
      status: 'handoff',
      reasons: outOfScope
        .map((o) => (o && o.description ? String(o.description) : 'a request outside the standard price list'))
        .filter(Boolean),
    };
  }

  // Nothing to quote yet.
  if (!rooms.length && !interiorDoors.length && !exteriorDoors.length && !windows.length && !railings.length) {
    return {
      status: 'need_info',
      missing: [{ item: 'job', field: 'scope', hint: 'What would you like painted or restored — a room, doors, windows, trim, a railing?' }],
    };
  }

  const missing = [];

  rooms.forEach((r, i) => {
    const size = norm(r && r.size);
    const condition = norm(r && r.condition);
    const label = 'room ' + (i + 1);
    if (!SIZES.includes(size)) {
      missing.push({ item: label, field: 'size', hint: 'Is ' + label + ' small, medium, or large? (bedrooms are usually medium)' });
    }
    if (!CONDITIONS.includes(condition)) {
      missing.push({ item: label, field: 'condition', hint: 'What condition is ' + label + ' in — good (minor prep), fair (some patching), or bad (real repairs)?' });
    }
  });

  interiorDoors.forEach((d, i) => {
    const condition = norm(d && d.condition);
    if (!CONDITIONS.includes(condition)) {
      missing.push({ item: 'interior door ' + (i + 1), field: 'condition', hint: 'What condition is the door in — good (light scuffs), fair (scratches/chips), or bad (peeling/gouges)?' });
    }
  });

  windows.forEach((w, i) => {
    const condition = norm(w && w.condition);
    if (!CONDITIONS.includes(condition)) {
      missing.push({ item: 'window ' + (i + 1), field: 'condition', hint: 'What condition are the windows in — good, fair, or bad?' });
    }
  });

  railings.forEach((rr, i) => {
    const condition = norm(rr && rr.condition);
    if (!CONDITIONS.includes(condition)) {
      missing.push({ item: 'railing ' + (i + 1), field: 'condition', hint: 'What condition is the banister/railing in — good, fair, or bad?' });
    }
  });

  if (missing.length) {
    return { status: 'need_info', missing };
  }

  // All required fields present — build line items.
  const lineItems = [];
  let hasDoor = false;

  rooms.forEach((r) => {
    const size = norm(r.size);
    const condition = norm(r.condition);
    const n = qty(r.quantity);

    const [rl, rh] = ROOM_RATES[size][condition];
    lineItems.push({
      description: titadel(size) + ' room — ' + condition + ' condition' + suf(n),
      detail: ROOM_DETAIL[condition],
      low: rl * n,
      high: rh * n,
    });

    if (r.ceiling) {
      const [cl, ch] = CEILING_RATES[size];
      lineItems.push({ description: 'Ceiling (' + size + ')' + suf(n), detail: 'Flat ceiling finish — cut in around edges and rolled.', low: cl * n, high: ch * n });
    }
    if (r.trim) {
      const [tl, th] = TRIM_RATES[size];
      lineItems.push({ description: 'Trim & baseboards (' + size + ')' + suf(n), detail: 'Baseboards, door casings, and window trim — prepped and finished in enamel with clean, controlled lines.', low: tl * n, high: th * n });
    }
    if (r.crown) {
      const [xl, xh] = CROWN_RATES[size];
      lineItems.push({ description: 'Crown molding (' + size + ')' + suf(n), detail: 'Crown molding cut in along the ceiling and wall lines — detailed overhead brushwork.', low: xl * n, high: xh * n });
    }
  });

  interiorDoors.forEach((d) => {
    hasDoor = true;
    const condition = norm(d.condition);
    const n = qty(d.quantity);
    const french = Boolean(d && d.french);
    const rates = french ? INTERIOR_FRENCH_DOOR_RATES : INTERIOR_DOOR_RATES;
    const [dl, dh] = rates[condition];
    lineItems.push({
      description: (french ? 'Interior French door' : 'Interior door') + ' — ' + condition + ' condition' + suf(n),
      detail: french
        ? 'Detailed brushwork — cut-in around every glass pane and muntin, prime as needed, then two coats; door rehung when dry.'
        : INT_DOOR_DETAIL[condition],
      low: dl * n,
      high: dh * n,
    });
  });

  exteriorDoors.forEach((d) => {
    hasDoor = true;
    const n = qty(d.quantity);
    const french = Boolean(d && d.french);
    const top = Boolean(d && (d.oversized || d.sidelight));

    let low, high, note, description, detail;
    if (french) {
      [low, high] = EXTERIOR_FRENCH_DOOR;
      description = 'Front / exterior French door restoration' + suf(n);
      detail = 'French-door restoration — surface + scratch repair, peeling-paint prep, priming, two coats of alkyd enamel, and detailed cut-in around every glass pane. Two visits (overnight cure); rehang and hardware included.';
      if (top) note = 'Oversized or sidelight — toward the top of the range.';
    } else {
      [low, high] = top ? EXTERIOR_DOOR_TOP : EXTERIOR_DOOR_BASE;
      description = 'Front / exterior door restoration' + suf(n);
      detail = 'On-site restoration: surface and scratch repair, peeling-paint prep, priming, and two coats of durable alkyd enamel. Spans two visits (overnight cure between coats); rehang and hardware reinstall included.';
      if (top) note = 'Priced toward the top of the range (oversized or sidelight).';
    }
    const item = { description, detail, low: low * n, high: high * n };
    if (note) item.note = note;
    lineItems.push(item);
  });

  windows.forEach((w) => {
    const condition = norm(w.condition);
    const n = qty(w.quantity);
    const [wl, wh] = WINDOW_RATES[condition];
    lineItems.push({
      description: 'Window trim & woodwork — ' + condition + ' condition' + suf(n),
      detail: WINDOW_DETAIL[condition],
      low: wl * n,
      high: wh * n,
    });
  });

  railings.forEach((rr) => {
    const condition = norm(rr.condition);
    const n = qty(rr.quantity);
    const [rl, rh] = RAILING_RATES[condition];
    lineItems.push({
      description: 'Banister / railing — ' + condition + ' condition' + suf(n),
      detail: RAILING_DETAIL[condition],
      low: rl * n,
      high: rh * n,
    });
  });

  const subtotalLow = lineItems.reduce((s, li) => s + li.low, 0);
  const subtotalHigh = lineItems.reduce((s, li) => s + li.high, 0);

  // $350 minimum: raise the low end to 350, leave the high as calculated
  // (clamped so it can never fall below the low end).
  const minimumApplied = subtotalLow < MINIMUM;
  const totalLow = minimumApplied ? MINIMUM : subtotalLow;
  const totalHigh = Math.max(subtotalHigh, totalLow);

  return {
    status: 'ok',
    line_items: lineItems,
    subtotal_low: subtotalLow,
    subtotal_high: subtotalHigh,
    minimum_applied: minimumApplied,
    total_low: totalLow,
    total_high: totalHigh,
    has_door: hasDoor,
  };
}
