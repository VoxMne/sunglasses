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
// drawn street with `kind = 'street'`. The view slowly pans like a handheld phone
// so the overlays have something to track.
export async function createDemoSource(kind = 'photo') {
  const world = kind === 'street' ? drawDemoWorld() : await loadImage(DEMO_PHOTO.src);
  const el = document.createElement('canvas');
  el.width = 1280;
  el.height = 960;
  const ctx = el.getContext('2d');

  // Look at ~80% of the scene so there is room to pan.
  const viewW = Math.min(world.width, world.width * 0.8);
  const viewH = (viewW * el.height) / el.width;
  const spareX = world.width - viewW;
  const spareY = Math.max(0, world.height - viewH);

  return {
    el,
    facing: 'demo',
    credit: kind === 'street' ? '' : DEMO_PHOTO.credit,
    width: el.width,
    height: el.height,
    ready: () => true,
    update(now) {
      const ox = spareX * (0.5 + 0.5 * Math.sin(now / 4200));
      const oy = spareY * (0.5 + 0.5 * Math.sin(now / 6100));
      ctx.drawImage(world, ox, oy, viewW, viewH, 0, 0, el.width, el.height);
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

  const sign = (x, y, w, h, bg, fg, lines, size) => {
    g.fillStyle = '#1a1a1a';
    g.fillRect(x - 8, y - 8, w + 16, h + 16);
    g.fillStyle = bg;
    g.fillRect(x, y, w, h);
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `900 ${size}px "Arial Black", Arial, sans-serif`;
    const step = h / (lines.length + 1);
    lines.forEach((t, i) => g.fillText(t, x + w / 2, y + step * (i + 1)));
  };

  sign(380, 190, 560, 220, '#f4f1e8', '#c0141c', ['BIG SUMMER SALE', '50% OFF'], 64);
  sign(1040, 330, 420, 170, '#ffd23f', '#111', ['NEW PHONE', 'UPGRADE NOW'], 48);
  sign(120, 470, 300, 120, '#1d4e9e', '#fff', ['HOTEL'], 72);
  sign(820, 560, 340, 110, '#fff', '#111', ['COFFEE'], 64);

  // A banknote taped to a wall
  g.save();
  g.translate(1260, 640);
  g.rotate(-0.06);
  g.fillStyle = '#c9d8b6';
  g.fillRect(0, 0, 330, 150);
  g.strokeStyle = '#3f5f3a';
  g.lineWidth = 6;
  g.strokeRect(10, 10, 310, 130);
  g.fillStyle = '#2f4a2c';
  g.textAlign = 'center';
  g.font = '900 30px "Arial Black", Arial, sans-serif';
  g.fillText('ONE DOLLAR', 165, 62);
  g.font = '900 22px "Arial Black", Arial, sans-serif';
  g.fillText('FEDERAL RESERVE NOTE', 165, 105);
  g.restore();

  return c;
}
