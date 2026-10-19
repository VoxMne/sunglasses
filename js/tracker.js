// Keeps the replaced signs on screen: matches new detections to existing overlays,
// moves them with the camera, merges duplicates, and fades them in and out.
//
// Boxes are tilted (see geometry.js): { cx, cy, w, h, a }. Each tracked sign has its
// current (drawn) box and a target box `t` it glides towards.

import { pickMessage, isMoneyText, MONEY_MESSAGE } from './messages.js';
import { bounds, moveInPlace, normAngle, overlap, union } from './geometry.js';

const DUPLICATE_OVERLAP = 0.5; // overlays covering each other this much are one sign

let nextId = 1;

export class Tracker {
  constructor() {
    this.boxes = [];
  }

  clear() {
    this.boxes = [];
  }

  get count() {
    return this.boxes.filter((b) => !b.dying).length;
  }

  // Moves every overlay with the camera (similarity transform in screen pixels).
  transform(m) {
    for (const b of this.boxes) {
      moveInPlace(m, b);
      moveInPlace(m, b.t);
    }
  }

  // Small per-sign correction on top of the camera motion.
  nudge(b, dx, dy) {
    b.cx += dx;
    b.cy += dy;
    b.t.cx += dx;
    b.t.cy += dy;
  }

  // region: the part of the screen that was scanned ({ x, y, w, h }).
  // zoomed: it was a close-up pass.
  update(detections, moneyMode, { region, zoomed = false } = {}) {
    const matched = new Set();
    for (const d of detections) {
      let best = null;
      let bestScore = 0.15;
      for (const b of this.boxes) {
        if (matched.has(b) || b.merged) continue;
        const score = overlap(b.t, d);
        if (score > bestScore) {
          bestScore = score;
          best = b;
        }
      }
      if (best) {
        // A partial read of the same sign (fully inside it) shouldn't shrink the overlay.
        const partial = bestScore > 0.85 && d.w * d.h < best.t.w * best.t.h * 0.8;
        if (!partial) {
          best.t = {
            cx: d.cx, cy: d.cy, w: d.w, h: d.h,
            // Square-ish text has no reliable direction: keep the sign's known tilt.
            a: d.sure ? d.a : best.t.a,
            sure: d.sure || best.t.sure,
          };
        }
        best.missed = 0;
        best.dying = false;
        if (zoomed) best.small = true;
        matched.add(best);
      } else {
        const id = nextId++;
        const msg = pickMessage(`#${id}`, false);
        const b = {
          id,
          cx: d.cx, cy: d.cy, w: d.w, h: d.h, a: d.a,
          t: { cx: d.cx, cy: d.cy, w: d.w, h: d.h, a: d.a, sure: d.sure },
          text: null,    // filled in later by the money reader
          baseMsg: msg,  // what it says when it isn't money
          msg: moneyMode ? MONEY_MESSAGE : msg,
          alpha: 0,
          missed: 0,
          dying: false,
          merged: false, // absorbed into another overlay; fading out fast
          small: zoomed, // only close-up passes can see it, so only they count misses
        };
        this.boxes.push(b);
        matched.add(b);
      }
    }
    for (const b of this.boxes) {
      if (matched.has(b)) continue;
      if (b.small && !zoomed) continue;
      if (region && !contains(region, b.t.cx, b.t.cy)) continue;
      if (++b.missed >= 3) b.dying = true;
    }
    this.mergeDuplicates();
  }

  // Overlays that cover the same sign (seen in different passes, or drifted onto each
  // other) become one: the bigger one stays and grows to cover both.
  mergeDuplicates() {
    const live = this.boxes.filter((b) => !b.dying);
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const p = live[i];
        const q = live[j];
        if (p.dying || q.dying || overlap(p.t, q.t) < DUPLICATE_OVERLAP) continue;
        const [keep, drop] = p.t.w * p.t.h >= q.t.w * q.t.h ? [p, q] : [q, p];
        keep.t = union(keep.t, drop.t);
        keep.small = keep.small && drop.small;
        if (drop.text && isMoneyText(drop.text)) this.setText(keep, drop.text);
        drop.dying = true;
        drop.merged = true;
      }
    }
  }

  setMoneyMode(moneyMode) {
    for (const b of this.boxes) {
      b.msg = moneyMode || (b.text && isMoneyText(b.text)) ? MONEY_MESSAGE : b.baseMsg;
    }
  }

  // The next visible sign nobody has tried to read yet (biggest first).
  nextUnread() {
    let best = null;
    for (const b of this.boxes) {
      if (b.text === null && !b.dying && b.alpha > 0.5 && (!best || b.w * b.h > best.w * best.h)) best = b;
    }
    return best;
  }

  setText(box, text) {
    box.text = text;
    if (isMoneyText(text)) box.msg = MONEY_MESSAGE;
  }

  step(dt, W, H) {
    const k = 1 - Math.exp(-dt * 9);
    for (const b of this.boxes) {
      b.cx += (b.t.cx - b.cx) * k;
      b.cy += (b.t.cy - b.cy) * k;
      b.w += (b.t.w - b.w) * k;
      b.h += (b.t.h - b.h) * k;
      b.a = normAngle(b.a + normAngle(b.t.a - b.a) * k);
      const r = bounds(b);
      if (r.x + r.w < 0 || r.y + r.h < 0 || r.x > W || r.y > H) b.dying = true;
      const target = b.dying ? 0 : 1;
      const speed = b.merged ? 12 : 5;
      b.alpha += Math.sign(target - b.alpha) * Math.min(Math.abs(target - b.alpha), dt * speed);
    }
    this.boxes = this.boxes.filter((b) => !(b.dying && b.alpha <= 0));
  }

  draw(ctx, jitter = 0) {
    for (const b of this.boxes) {
      if (b.alpha <= 0) continue;
      const pad = Math.max(4, b.h * 0.18);
      const w = b.w + pad * 2;
      const h = b.h + pad * 2;
      ctx.save();
      ctx.globalAlpha = b.alpha;
      ctx.translate(b.cx + (Math.random() - 0.5) * jitter, b.cy + (Math.random() - 0.5) * jitter);
      ctx.rotate(b.a);
      ctx.fillStyle = '#eeeeea';
      ctx.fillRect(-w / 2, -h / 2, w, h);
      drawFitted(ctx, b.msg, w, h);
      ctx.restore();
    }
  }
}

function contains(r, x, y) {
  return x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;
}

const FONT = '"Helvetica Neue", "Arial Black", Arial, sans-serif';

// Ways to break each message over 1–3 lines, with each layout's widest line measured
// once at 100px (text width scales with font size, so no measuring per frame).
const layoutCache = new Map();

function layoutsFor(ctx, msg) {
  let layouts = layoutCache.get(msg);
  if (layouts) return layouts;
  const words = msg.split(' ');
  const options = [[msg]];
  for (let i = 1; i < words.length; i++) {
    options.push([words.slice(0, i).join(' '), words.slice(i).join(' ')]);
  }
  if (words.length > 2) {
    const third = Math.ceil(words.length / 3);
    options.push([
      words.slice(0, third).join(' '),
      words.slice(third, third * 2).join(' '),
      words.slice(third * 2).join(' '),
    ].filter(Boolean));
  }
  ctx.font = `900 100px ${FONT}`;
  layouts = options.map((lines) => ({ lines, widest: Math.max(...lines.map((l) => ctx.measureText(l).width)) }));
  layoutCache.set(msg, layouts);
  return layouts;
}

// Black block letters, as big as fit in a w x h panel centered on the origin.
function drawFitted(ctx, msg, w, h) {
  let best = null;
  for (const { lines, widest } of layoutsFor(ctx, msg)) {
    const size = Math.min((w * 0.9 * 100) / widest, (h * 0.92) / (lines.length * 0.95));
    if (!best || size > best.size) best = { lines, size };
  }
  const size = Math.max(4, best.size);
  ctx.font = `900 ${size}px ${FONT}`;
  ctx.fillStyle = '#050505';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lineH = size * 0.95;
  const top = -(lineH * (best.lines.length - 1)) / 2;
  best.lines.forEach((line, i) => ctx.fillText(line, 0, top + i * lineH));
}
