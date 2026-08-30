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

// Add-ons, per room, by size: [low, high]
export const CEILING_RATES = { small: [75, 90],  medium: [100, 120], large: [150, 180] };
export const TRIM_RATES    = { small: [50, 60],  medium: [75, 90],   large: [100, 120] };

// Interior door, per door: condition -> [low, high]
export const INTERIOR_DOOR_RATES = { good: [120, 150], fair: [160, 200], bad: [220, 280] };

// Exterior / front-entry door, per door
export const EXTERIOR_DOOR_BASE = [500, 800];
export const EXTERIOR_DOOR_TOP  = [650, 800]; // oversized or with a sidelight

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
  if (!rooms.length && !interiorDoors.length && !exteriorDoors.length) {
    return {
      status: 'need_info',
      missing: [{ item: 'job', field: 'scope', hint: 'What would you like painted or restored — rooms, interior doors, or a front/exterior door?' }],
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

  if (missing.length) {
    return { status: 'need_info', missing };
  }

  // All required fields present — build line items.
  const lineItems = [];
  let hasDoor = false;

  const ROOM_DETAIL = {
    good: 'Light prep, spot-priming as needed, and two finish coats on the walls. Minor drywall patches included.',
    fair: 'Patching, sanding, and spot-priming to smooth out imperfections, then two finish coats. Minor drywall patches included.',
    bad: 'Heavier repair — filling, sanding, and feathering damaged areas into the wall — then priming and two finish coats. Minor drywall patches included.',
  };

  rooms.forEach((r) => {
    const size = norm(r.size);
    const condition = norm(r.condition);
    const n = qty(r.quantity);
    const suffix = n > 1 ? ' (×' + n + ')' : '';

    const [rl, rh] = ROOM_RATES[size][condition];
    lineItems.push({
      description: titadel(size) + ' room — ' + condition + ' condition' + suffix,
      detail: ROOM_DETAIL[condition],
      low: rl * n,
      high: rh * n,
    });

    if (r.ceiling) {
      const [cl, ch] = CEILING_RATES[size];
      lineItems.push({
        description: 'Ceiling (' + size + ')' + suffix,
        detail: 'Flat ceiling finish — cut in around edges and rolled.',
        low: cl * n,
        high: ch * n,
      });
    }
    if (r.trim) {
      const [tl, th] = TRIM_RATES[size];
      lineItems.push({
        description: 'Trim & baseboards (' + size + ')' + suffix,
        detail: 'Baseboards, door casings, and window trim — prepped and finished in enamel with clean, controlled lines.',
        low: tl * n,
        high: th * n,
      });
    }
  });

  interiorDoors.forEach((d) => {
    hasDoor = true;
    const condition = norm(d.condition);
    const n = qty(d.quantity);
    const suffix = n > 1 ? ' (×' + n + ')' : '';
    const detail = {
      good: 'Scuff-sand and two coats for a clean, even finish; door rehung when dry.',
      fair: 'Fill scratches and minor chips, sand, prime, then two coats; door rehung when dry.',
      bad: 'Repair peeling, gouges, and damaged areas first, then prime and two coats; door rehung when dry.',
    }[condition];
    const [dl, dh] = INTERIOR_DOOR_RATES[condition];
    lineItems.push({
      description: 'Interior door — ' + condition + ' condition' + suffix,
      detail: detail,
      low: dl * n,
      high: dh * n,
    });
  });

  exteriorDoors.forEach((d) => {
    hasDoor = true;
    const n = qty(d.quantity);
    const suffix = n > 1 ? ' (×' + n + ')' : '';
    const top = Boolean(d && (d.oversized || d.sidelight));
    const [el, eh] = top ? EXTERIOR_DOOR_TOP : EXTERIOR_DOOR_BASE;
    const item = {
      description: 'Front / exterior door restoration' + suffix,
      detail: 'On-site restoration: surface and scratch repair, peeling-paint prep, priming, and two coats of durable alkyd enamel. Spans two visits (overnight cure between coats); rehang and hardware reinstall included.',
      low: el * n,
      high: eh * n,
    };
    if (top) item.note = 'Priced toward the top of the range (oversized or sidelight).';
    lineItems.push(item);
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
