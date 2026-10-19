// The "glasses" look: harsh black and white, grain, vignette, and the headache glitch.

const FILTER = 'grayscale(1) contrast(1.9) brightness(1.08)';

export class Effects {
  constructor() {
    this.canvasFilter = supportsCanvasFilter();
    this.grain = Array.from({ length: 4 }, () => makeNoise(160));
    this.grainPatterns = null;
    this.vignette = null;
    this.vignetteKey = '';
    this.scratch = document.createElement('canvas');
    this.scratchCtx = this.scratch.getContext('2d', { willReadFrequently: true });
    this.lut = buildContrastLut();
  }

  // Draws the source cropped to fill the canvas in high-contrast black and white.
  drawFiltered(ctx, el, crop, W, H) {
    if (this.canvasFilter) {
      ctx.filter = FILTER;
      ctx.drawImage(el, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, W, H);
      ctx.filter = 'none';
      return;
    }
    // Fallback for browsers without ctx.filter (older Safari): process at half size.
    const w = Math.max(1, Math.round(W / 2));
    const h = Math.max(1, Math.round(H / 2));
    if (this.scratch.width !== w || this.scratch.height !== h) {
      this.scratch.width = w;
      this.scratch.height = h;
    }
    const s = this.scratchCtx;
    s.drawImage(el, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h);
    const img = s.getImageData(0, 0, w, h);
    const d = img.data;
    const lut = this.lut;
    for (let i = 0; i < d.length; i += 4) {
      const v = lut[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8];
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    s.putImageData(img, 0, 0);
    ctx.drawImage(this.scratch, 0, 0, W, H);
  }

  // Grain, vignette and a faint flicker on top of everything.
  finish(ctx, W, H) {
    if (!this.grainPatterns) {
      this.grainPatterns = this.grain.map((c) => ctx.createPattern(c, 'repeat'));
    }
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = this.grainPatterns[(Math.random() * this.grainPatterns.length) | 0];
    ctx.translate(-Math.random() * 160, -Math.random() * 160);
    ctx.fillRect(0, 0, W + 160, H + 160);
    ctx.restore();

    const key = `${W}x${H}`;
    if (key !== this.vignetteKey) {
      const r = Math.hypot(W, H) / 2;
      const grad = ctx.createRadialGradient(W / 2, H / 2, r * 0.45, W / 2, H / 2, r);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(0,0,0,0.8)');
      this.vignette = grad;
      this.vignetteKey = key;
    }
    ctx.fillStyle = this.vignette;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.06})`;
    ctx.fillRect(0, 0, W, H);
  }

  // intensity 0..1 — gets worse the longer the glasses stay on.
  headache(ctx, canvas, W, H, intensity, now) {
    if (intensity <= 0) return;

    const slices = Math.floor(intensity * 7 * Math.random());
    for (let i = 0; i < slices; i++) {
      const y = Math.random() * H;
      const h = 4 + Math.random() * H * 0.06;
      const dx = (Math.random() - 0.5) * W * 0.1 * intensity;
      ctx.drawImage(canvas, 0, y, W, h, dx, y, W, h);
    }

    const pulse = 0.5 + 0.5 * Math.sin(now / 170);
    ctx.fillStyle = `rgba(0,0,0,${0.3 * intensity * pulse})`;
    ctx.fillRect(0, 0, W, H);

    if (Math.random() < 0.025 * intensity) {
      ctx.save();
      ctx.globalCompositeOperation = 'difference';
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }
}

function supportsCanvasFilter() {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.filter = 'grayscale(1)';
    ctx.fillStyle = '#f00';
    ctx.fillRect(0, 0, 1, 1);
    const [r, g] = ctx.getImageData(0, 0, 1, 1).data;
    return Math.abs(r - g) < 10;
  } catch {
    return false;
  }
}

function makeNoise(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function buildContrastLut() {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = (i - 128) * 1.9 + 138;
  return lut;
}
