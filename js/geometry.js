// Tilted boxes and camera motion.
//
// A box is { cx, cy, w, h, a, sure }: its center, its size along its own axes, its
// angle in radians (positive = clockwise, since screen y points down), and whether
// that angle is reliable — square-ish text has no clear direction, so it gets a = 0
// and sure = false.
//
// Camera motion is a similarity transform { a, b, tx, ty } (slide + zoom + roll):
//   x' = a·x − b·y + tx
//   y' = b·x + a·y + ty        zoom = hypot(a, b), roll = atan2(b, a)

const MAX_MERGE_ANGLE = 0.17; // ~10°: text lines tilted further apart aren't one sign

export const IDENTITY = Object.freeze({ a: 1, b: 0, tx: 0, ty: 0 });

// m2 applied after m1.
export function compose(m2, m1) {
  return {
    a: m2.a * m1.a - m2.b * m1.b,
    b: m2.a * m1.b + m2.b * m1.a,
    tx: m2.a * m1.tx - m2.b * m1.ty + m2.tx,
    ty: m2.b * m1.tx + m2.a * m1.ty + m2.ty,
  };
}

export function invert(m) {
  const d = m.a * m.a + m.b * m.b;
  const a = m.a / d;
  const b = -m.b / d;
  return { a, b, tx: -(a * m.tx - b * m.ty), ty: -(b * m.tx + a * m.ty) };
}

// Moves a box with the camera, in place.
export function moveInPlace(m, box) {
  const zoom = Math.hypot(m.a, m.b);
  const cx = m.a * box.cx - m.b * box.cy + m.tx;
  box.cy = m.b * box.cx + m.a * box.cy + m.ty;
  box.cx = cx;
  box.w *= zoom;
  box.h *= zoom;
  box.a = normAngle(box.a + Math.atan2(m.b, m.a));
  return box;
}

export const moveBox = (m, box) => moveInPlace(m, { ...box });

// Scales a box by different factors along x and y (an image resized to another aspect).
export function scaleBox(box, kx, ky) {
  const c = Math.cos(box.a);
  const s = Math.sin(box.a);
  return {
    ...box,
    cx: box.cx * kx,
    cy: box.cy * ky,
    w: box.w * Math.hypot(kx * c, ky * s),
    h: box.h * Math.hypot(kx * s, ky * c),
    a: Math.atan2(ky * s, kx * c),
  };
}

// Text direction is the same after half a turn: keep angles in (−90°, 90°].
export function normAngle(a) {
  while (a > Math.PI / 2) a -= Math.PI;
  while (a <= -Math.PI / 2) a += Math.PI;
  return a;
}

// The straight (unrotated) extent of a box, seen in a frame turned by `angle`.
export function extents(box, angle = 0) {
  const d = box.a - angle;
  const c = Math.abs(Math.cos(d));
  const s = Math.abs(Math.sin(d));
  const hw = (box.w * c + box.h * s) / 2;
  const hh = (box.w * s + box.h * c) / 2;
  const u = box.cx * Math.cos(angle) + box.cy * Math.sin(angle);
  const v = -box.cx * Math.sin(angle) + box.cy * Math.cos(angle);
  return { x: u - hw, y: v - hh, w: 2 * hw, h: 2 * hh };
}

// Screen-aligned bounding box { x, y, w, h }.
export const bounds = (box) => extents(box, 0);

// The direction to compare two boxes in, or null if they're tilted too differently.
export function commonAngle(p, q) {
  if (p.sure && q.sure) {
    const diff = normAngle(p.a - q.a);
    if (Math.abs(diff) > MAX_MERGE_ANGLE) return null;
    const wp = p.w * p.h;
    const wq = q.w * q.h;
    return normAngle(q.a + (diff * wp) / (wp + wq));
  }
  if (p.sure) return p.a;
  if (q.sure) return q.a;
  return 0;
}

// Intersection over the smaller box: tolerant of a sign being read as fewer words.
export function overlap(p, q) {
  const angle = commonAngle(p, q) ?? 0;
  const A = extents(p, angle);
  const B = extents(q, angle);
  const ix = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
  const iy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
  if (ix <= 0 || iy <= 0) return 0;
  return (ix * iy) / Math.min(A.w * A.h, B.w * B.h);
}

// The smallest box, in the two boxes' shared direction, that covers both.
export function union(p, q) {
  const angle = commonAngle(p, q) ?? 0;
  const A = extents(p, angle);
  const B = extents(q, angle);
  const x0 = Math.min(A.x, B.x);
  const y0 = Math.min(A.y, B.y);
  const x1 = Math.max(A.x + A.w, B.x + B.w);
  const y1 = Math.max(A.y + A.h, B.y + B.h);
  const u = (x0 + x1) / 2;
  const v = (y0 + y1) / 2;
  return {
    cx: u * Math.cos(angle) - v * Math.sin(angle),
    cy: u * Math.sin(angle) + v * Math.cos(angle),
    w: x1 - x0,
    h: y1 - y0,
    a: angle,
    sure: Boolean(p.sure || q.sure),
  };
}

// Joins boxes on one line, and stacked lines of one sign, into a single box,
// so each sign gets one message.
export function mergeBoxes(boxes) {
  const list = boxes.map((b) => ({ ...b }));
  let changed = true;
  while (changed) {
    changed = false;
    outer:
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (sameSign(list[i], list[j])) {
          list[i] = union(list[i], list[j]);
          list.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return list;
}

function sameSign(p, q) {
  const angle = commonAngle(p, q);
  if (angle === null) return false;
  const a = extents(p, angle);
  const b = extents(q, angle);
  const hMin = Math.min(a.h, b.h);
  const hMax = Math.max(a.h, b.h);
  const vOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const hOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);

  // Overlapping boxes are the same text.
  if (vOverlap > 0 && hOverlap > 0) return true;
  if (hMax > hMin * 2.2) return false;
  // Same line, close together.
  if (vOverlap > hMin * 0.5 && -hOverlap < hMin * 0.9) return true;
  // Stacked lines of the same sign.
  if (hOverlap > Math.min(a.w, b.w) * 0.4 && -vOverlap < hMin * 0.9) return true;
  return false;
}
