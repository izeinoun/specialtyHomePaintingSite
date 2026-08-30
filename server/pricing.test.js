// Unit tests for the deterministic quote calculator.
// Run: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateQuote, MINIMUM } from './pricing.js';

test('single large/good room prices from the matrix, above minimum', () => {
  const q = calculateQuote({ rooms: [{ size: 'large', condition: 'good' }] });
  assert.equal(q.status, 'ok');
  assert.equal(q.line_items.length, 1);
  assert.deepEqual([q.line_items[0].low, q.line_items[0].high], [400, 480]);
  assert.equal(q.subtotal_low, 400);
  assert.equal(q.subtotal_high, 480);
  assert.equal(q.minimum_applied, false); // 400 >= 350
  assert.deepEqual([q.total_low, q.total_high], [400, 480]);
  assert.equal(q.has_door, false);
});

test('medium/fair room ($325) is bumped to the $350 minimum on the low end', () => {
  const q = calculateQuote({ rooms: [{ size: 'medium', condition: 'fair' }] });
  assert.deepEqual([q.line_items[0].low, q.line_items[0].high], [325, 390]);
  assert.equal(q.minimum_applied, true); // 325 < 350
  assert.deepEqual([q.total_low, q.total_high], [350, 390]);
});

test('small/good room falls under the $350 minimum -> low raised, high clamped', () => {
  const q = calculateQuote({ rooms: [{ size: 'small', condition: 'good' }] });
  assert.equal(q.subtotal_low, 150);
  assert.equal(q.subtotal_high, 180);
  assert.equal(q.minimum_applied, true);
  assert.equal(q.total_low, MINIMUM);
  assert.equal(q.total_high, MINIMUM); // high (180) clamped up to the low (350)
});

test('two fair interior doors match the documented $320-400 -> $350-400 example', () => {
  const q = calculateQuote({ interior_doors: [{ condition: 'fair', quantity: 2 }] });
  assert.equal(q.subtotal_low, 320);
  assert.equal(q.subtotal_high, 400);
  assert.equal(q.minimum_applied, true);
  assert.deepEqual([q.total_low, q.total_high], [350, 400]);
  assert.equal(q.has_door, true);
});

test('room with ceiling and trim add-ons sums all three line items', () => {
  const q = calculateQuote({ rooms: [{ size: 'medium', condition: 'good', ceiling: true, trim: true }] });
  assert.equal(q.line_items.length, 3);
  // 250-300 + 100-120 + 75-90
  assert.deepEqual([q.total_low, q.total_high], [425, 510]);
});

test('exterior door base range', () => {
  const q = calculateQuote({ exterior_doors: [{ quantity: 1 }] });
  assert.deepEqual([q.total_low, q.total_high], [500, 800]);
  assert.equal(q.has_door, true);
  assert.equal(q.line_items[0].note, undefined);
});

test('oversized / sidelight exterior door prices toward the top with a note', () => {
  const over = calculateQuote({ exterior_doors: [{ oversized: true }] });
  assert.deepEqual([over.total_low, over.total_high], [650, 800]);
  assert.match(over.line_items[0].note, /oversized|sidelight/i);

  const side = calculateQuote({ exterior_doors: [{ sidelight: true }] });
  assert.deepEqual([side.total_low, side.total_high], [650, 800]);
});

test('quantity multiplies line totals', () => {
  const q = calculateQuote({ rooms: [{ size: 'small', condition: 'good', quantity: 3 }] });
  assert.deepEqual([q.line_items[0].low, q.line_items[0].high], [450, 540]);
  assert.match(q.line_items[0].description, /×3/);
});

test('mixed room + interior door sums correctly and flags a door', () => {
  const q = calculateQuote({
    rooms: [{ size: 'medium', condition: 'fair' }],
    interior_doors: [{ condition: 'fair' }],
  });
  // 325-390 + 160-200
  assert.deepEqual([q.total_low, q.total_high], [485, 590]);
  assert.equal(q.has_door, true);
});

test('missing room condition -> need_info naming the field', () => {
  const q = calculateQuote({ rooms: [{ size: 'medium' }] });
  assert.equal(q.status, 'need_info');
  assert.ok(q.missing.some((m) => m.field === 'condition'));
});

test('invalid size -> need_info (never crashes on bad enum)', () => {
  const q = calculateQuote({ rooms: [{ size: 'huge', condition: 'good' }] });
  assert.equal(q.status, 'need_info');
  assert.ok(q.missing.some((m) => m.field === 'size'));
});

test('empty params -> need_info asking for scope', () => {
  const q = calculateQuote({});
  assert.equal(q.status, 'need_info');
  assert.equal(q.missing[0].field, 'scope');
});

test('out_of_scope work -> handoff to Issam with reasons', () => {
  const q = calculateQuote({
    rooms: [{ size: 'medium', condition: 'good' }],
    out_of_scope: [{ description: 'Large drywall hole needing a photo review' }],
  });
  assert.equal(q.status, 'handoff');
  assert.match(q.reasons[0], /drywall/i);
});

test('null / undefined params do not throw', () => {
  assert.equal(calculateQuote(undefined).status, 'need_info');
  assert.equal(calculateQuote(null).status, 'need_info');
});

// ---- expanded catalog: windows, railings, crown, French doors ----

test('windows price by condition', () => {
  const q = calculateQuote({ windows: [{ condition: 'fair', quantity: 3 }] });
  // 3 x 90-140
  assert.deepEqual([q.line_items[0].low, q.line_items[0].high], [270, 420]);
  assert.match(q.line_items[0].description, /window/i);
});

test('banister / railing prices by condition', () => {
  const q = calculateQuote({ railings: [{ condition: 'bad' }] });
  assert.deepEqual([q.line_items[0].low, q.line_items[0].high], [400, 575]);
  assert.match(q.line_items[0].description, /banister|railing/i);
});

test('crown molding add-on on a room', () => {
  const q = calculateQuote({ rooms: [{ size: 'medium', condition: 'good', crown: true }] });
  assert.equal(q.line_items.length, 2); // room + crown
  // 250-300 + 110-150
  assert.deepEqual([q.total_low, q.total_high], [360, 450]);
  assert.match(q.line_items[1].description, /crown/i);
});

test('interior French door costs more than a standard interior door', () => {
  const std = calculateQuote({ interior_doors: [{ condition: 'fair' }] });
  const fr = calculateQuote({ interior_doors: [{ condition: 'fair', french: true }] });
  assert.deepEqual([std.line_items[0].low, std.line_items[0].high], [160, 200]);
  assert.deepEqual([fr.line_items[0].low, fr.line_items[0].high], [340, 430]);
  assert.match(fr.line_items[0].description, /french/i);
  assert.equal(fr.has_door, true);
});

test('exterior French door uses the premium range', () => {
  const q = calculateQuote({ exterior_doors: [{ french: true }] });
  assert.deepEqual([q.total_low, q.total_high], [900, 1300]);
  assert.match(q.line_items[0].description, /french/i);
});

test('window missing condition -> need_info', () => {
  const q = calculateQuote({ windows: [{ quantity: 2 }] });
  assert.equal(q.status, 'need_info');
  assert.ok(q.missing.some((m) => m.field === 'condition'));
});
