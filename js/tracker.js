// Keeps the replaced signs on screen: matches new detections to existing overlays,
// moves them with the camera, and fades them in and out.

import { pickMessage, isMoneyText, MONEY_MESSAGE } from './messages.js';

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

  // Moves everything by the camera motion (screen pixels).
  shift(dx, dy) {
    for (const b of this.boxes) {
      b.x += dx; b.y += dy;
      b.t.x += dx; b.t.y += dy;
    }
  }

  // region: the part of the screen that was scanned. zoomed: it was a close-up pass.
  update(detections, moneyMode, { region, zoomed = false } = {}) {
    const matched = new Set();
    for (const d of detections) {
      let best = null;
      let bestScore = 0.15;
      for (const b of this.boxes) {
        if (matched.has(b)) continue;
        const score = overlap(b.t, d);
        if (score > bestScore) {
          bestScore = score;
          best = b;
        }
      }
      if (best) {
        // A partial read of the same sign (fully inside it) shouldn't shrink the overlay.
        const partial = bestScore > 0.85 && d.w * d.h < best.t.w * best.t.h * 0.8;
        if (!partial) best.t = { x: d.x, y: d.y, w: d.w, h: d.h };
        best.missed = 0;
        best.dying = false;
        if (zoomed) best.small = true;
        matched.add(best);
      } else {
        const id = nextId++;
        const b = {
          id,
          x: d.x, y: d.y, w: d.w, h: d.h,
          t: { x: d.x, y: d.y, w: d.w, h: d.h },
          text: null,   // filled in later by the money reader
          msg: pickMessage(`#${id}`, moneyMode),
          alpha: 0,
          missed: 0,
          dying: false,
          small: zoomed, // only close-up passes can see it, so only they count misses
        };
        this.boxes.push(b);
        matched.add(b);
      }
    }
    for (const b of this.boxes) {
      if (matched.has(b)) continue;
      if (b.small && !zoomed) continue;
      if (region && !contains(region, b.t.x + b.t.w / 2, b.t.y + b.t.h / 2)) continue;
      if (++b.missed >= 3) b.dying = true;
    }
  }

  setMoneyMode(moneyMode) {
    for (const b of this.boxes) b.msg = pickMessage(b.text || `#${b.id}`, moneyMode);
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
      b.x += (b.t.x - b.x) * k;
      b.y += (b.t.y - b.y) * k;
      b.w += (b.t.w - b.w) * k;
      b.h += (b.t.h - b.h) * k;
      const offscreen = b.x + b.w < 0 || b.y + b.h < 0 || b.x > W || b.y > H;
      if (offscreen) b.dying = true;
      const target = b.dying ? 0 : 1;
      b.alpha += Math.sign(target - b.alpha) * Math.min(Math.abs(target - b.alpha), dt * 5);
    }
    this.boxes = this.boxes.filter((b) => !(b.dying && b.alpha <= 0));
  }

  draw(ctx, jitter = 0) {
    for (const b of this.boxes) {
      if (b.alpha <= 0) continue;
      const pad = Math.max(4, b.h * 0.18);
      const x = b.x - pad + (Math.random() - 0.5) * jitter;
      const y = b.y - pad + (Math.random() - 0.5) * jitter;
      const w = b.w + pad * 2;
      const h = b.h + pad * 2;

      ctx.globalAlpha = b.alpha;
      ctx.fillStyle = '#eeeeea';
      ctx.fillRect(x, y, w, h);
      drawFitted(ctx, b.msg, x, y, w, h);
    }
    ctx.globalAlpha = 1;
  }
}

function contains(r, x, y) {
  return x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;
}

// Intersection over the smaller box: tolerant of a sign being read as fewer words.
function overlap(a, b) {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ix <= 0 || iy <= 0) return 0;
  return (ix * iy) / Math.min(a.w * a.h, b.w * b.h);
}

const FONT = '"Helvetica Neue", "Arial Black", Arial, sans-serif';

// Black block letters, as big as fit, split over 1–3 lines.
function drawFitted(ctx, msg, x, y, w, h) {
  const words = msg.split(' ');
  const layouts = [[msg]];
  if (words.length > 1) {
    for (let i = 1; i < words.length; i++) {
      layouts.push([words.slice(0, i).join(' '), words.slice(i).join(' ')]);
    }
  }
  if (words.length > 2) {
    const third = Math.ceil(words.length / 3);
    layouts.push([
      words.slice(0, third).join(' '),
      words.slice(third, third * 2).join(' '),
      words.slice(third * 2).join(' '),
    ].filter(Boolean));
  }

  ctx.font = `900 100px ${FONT}`;
  let best = null;
  for (const lines of layouts) {
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const size = Math.min((w * 0.9 * 100) / widest, (h * 0.92) / (lines.length * 0.95));
    if (!best || size > best.size) best = { lines, size };
  }

  const size = Math.max(4, best.size);
  ctx.font = `900 ${size}px ${FONT}`;
  ctx.fillStyle = '#050505';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lineH = size * 0.95;
  const top = y + h / 2 - (lineH * (best.lines.length - 1)) / 2;
  best.lines.forEach((line, i) => ctx.fillText(line, x + w / 2, top + i * lineH));
}
