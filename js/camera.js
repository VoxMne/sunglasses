// Video sources. Each source exposes { el, width, height, ready(), update?(now), stop() }.

let currentStream = null;

export async function startCamera(video, facing = 'environment') {
  stopStream();
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser cannot access the camera. It needs HTTPS (or localhost).');
  }
  currentStream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: false,
  });
  video.srcObject = currentStream;
  await video.play();

  return {
    el: video,
    facing,
    get width() { return video.videoWidth; },
    get height() { return video.videoHeight; },
    ready: () => video.readyState >= 2 && video.videoWidth > 0,
    stop: stopStream,
  };
}

function stopStream() {
  currentStream?.getTracks().forEach((t) => t.stop());
  currentStream = null;
}

export const DEMO_PHOTO = {
  src: 'demo/belgrade.jpg',
  credit: 'Photo: Knez Mihailova Street, Belgrade — Jaimrsilva, CC BY-SA 4.0, via Wikimedia Commons',
};

// Used when there is no camera (desktop testing, demos): a real street photo, or a
// drawn street with `kind = 'street'`. The view drifts like a handheld phone —
// panning, a little roll and stepping closer and back — so the overlays have
// something to track.
const DEMO_ROLL = 0.07; // radians (~4°)
const DEMO_ZOOM = 0.05; // up to 5% closer

export async function createDemoSource(kind = 'photo') {
  const world = kind === 'street' ? drawDemoWorld() : await loadImage(DEMO_PHOTO.src);
  const el = document.createElement('canvas');
  el.width = 1280;
  el.height = 960;
  const ctx = el.getContext('2d');

  // Look at ~80% of the scene, keeping the rolled view inside it while panning.
  const viewW = world.width * 0.8;
  const viewH = (viewW * el.height) / el.width;
  const sin = Math.sin(DEMO_ROLL);
  const cos = Math.cos(DEMO_ROLL);
  const reachX = (viewW * cos + viewH * sin) / 2;
  const reachY = (viewW * sin + viewH * cos) / 2;
  const panX = Math.max(0, world.width / 2 - reachX);
  const panY = Math.max(0, world.height / 2 - reachY);

  return {
    el,
    facing: 'demo',
    credit: kind === 'street' ? '' : DEMO_PHOTO.credit,
    width: el.width,
    height: el.height,
    ready: () => true,
    update(now) {
      const cx = world.width / 2 + panX * Math.sin(now / 4200);
      const cy = world.height / 2 + panY * Math.sin(now / 6100);
      const roll = DEMO_ROLL * Math.sin(now / 3700);
      const zoom = 1 + DEMO_ZOOM * (0.5 + 0.5 * Math.sin(now / 5300));
      const k = (el.width / viewW) * zoom;
      ctx.save();
      ctx.translate(el.width / 2, el.height / 2);
      ctx.rotate(roll);
      ctx.scale(k, k);
      ctx.drawImage(world, -cx, -cy);
      ctx.restore();
    },
    stop() {},
  };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load the demo photo (${src}).`));
    img.src = src;
  });
}

function drawDemoWorld() {
  const c = document.createElement('canvas');
  c.width = 1700;
  c.height = 1150;
  const g = c.getContext('2d');

  const sky = g.createLinearGradient(0, 0, 0, c.height);
  sky.addColorStop(0, '#6f8fb5');
  sky.addColorStop(0.55, '#b9c6d4');
  sky.addColorStop(1, '#3a3a3a');
  g.fillStyle = sky;
  g.fillRect(0, 0, c.width, c.height);

  // Buildings
  const buildings = [
    [0, 260, 360, '#5b4a3f'], [340, 140, 420, '#7a6b5d'], [740, 320, 380, '#4d5560'],
    [1100, 200, 330, '#6e5c4c'], [1410, 300, 290, '#565049'],
  ];
  for (const [x, y, w, color] of buildings) {
    g.fillStyle = color;
    g.fillRect(x, y, w, c.height - y);
    g.fillStyle = 'rgba(20,25,35,0.55)';
    for (let wy = y + 30; wy < c.height - 220; wy += 70) {
      for (let wx = x + 25; wx < x + w - 40; wx += 60) g.fillRect(wx, wy, 32, 42);
    }
  }

  // Street
  g.fillStyle = '#2b2b2b';
  g.fillRect(0, c.height - 190, c.width, 190);
  g.fillStyle = '#ddd';
  for (let x = 30; x < c.width; x += 140) g.fillRect(x, c.height - 95, 70, 10);

  // A framed sign, optionally hung at an angle (radians).
  const sign = (x, y, w, h, bg, fg, lines, size, tilt = 0) => {
    g.save();
    g.translate(x + w / 2, y + h / 2);
    g.rotate(tilt);
    g.fillStyle = '#1a1a1a';
    g.fillRect(-w / 2 - 8, -h / 2 - 8, w + 16, h + 16);
    g.fillStyle = bg;
    g.fillRect(-w / 2, -h / 2, w, h);
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `900 ${size}px "Arial Black", Arial, sans-serif`;
    const step = h / (lines.length + 1);
    lines.forEach((t, i) => g.fillText(t, 0, -h / 2 + step * (i + 1)));
    g.restore();
  };

  // A banknote taped to a wall.
  const note = (x, y, tilt, paper, ink, big, small) => {
    g.save();
    g.translate(x, y);
    g.rotate(tilt);
    g.fillStyle = paper;
    g.fillRect(0, 0, 330, 150);
    g.strokeStyle = ink;
    g.lineWidth = 6;
    g.strokeRect(10, 10, 310, 130);
    g.fillStyle = ink;
    g.textAlign = 'center';
    g.font = '900 30px "Arial Black", Arial, sans-serif';
    g.fillText(big, 165, 62);
    g.font = '900 20px "Arial Black", Arial, sans-serif';
    g.fillText(small, 165, 105);
    g.restore();
  };

  sign(380, 190, 560, 220, '#f4f1e8', '#c0141c', ['BIG SUMMER SALE', '50% OFF'], 64);
  sign(1040, 330, 420, 170, '#ffd23f', '#111', ['NEW PHONE', 'UPGRADE NOW'], 48, 0.14);
  sign(120, 470, 300, 120, '#1d4e9e', '#fff', ['HOTEL'], 72);
  sign(820, 560, 340, 110, '#fff', '#111', ['COFFEE'], 64);
  note(1260, 640, -0.06, '#c9d8b6', '#2f4a2c', 'ONE DOLLAR', 'FEDERAL RESERVE NOTE');
  note(520, 760, 0.1, '#e3cfa4', '#5a3b1e', '100 ДИНАРА', 'НАРОДНА БАНКА СРБИЈЕ');

  return c;
}
