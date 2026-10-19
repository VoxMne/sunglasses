// Photos and video recordings of the canvas.

export async function savePhoto(canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  if (!blob) throw new Error('Could not capture the photo.');
  return shareOrDownload(blob, `sunglasses-${stamp()}.jpg`);
}

export class Recorder {
  constructor() {
    this.rec = null;
    this.chunks = [];
  }

  get recording() {
    return this.rec?.state === 'recording';
  }

  static supported(canvas) {
    return typeof MediaRecorder !== 'undefined' && typeof canvas.captureStream === 'function';
  }

  start(canvas) {
    const mimeType = [
      'video/mp4;codecs=avc1',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm',
    ].find((t) => MediaRecorder.isTypeSupported(t));
    const stream = canvas.captureStream(30);
    this.chunks = [];
    this.rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 6_000_000 } : undefined);
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(500);
  }

  stop() {
    return new Promise((resolve) => {
      const rec = this.rec;
      rec.onstop = () => {
        rec.stream.getTracks().forEach((t) => t.stop());
        const type = rec.mimeType || 'video/webm';
        const ext = type.includes('mp4') ? 'mp4' : 'webm';
        const blob = new Blob(this.chunks, { type });
        resolve(shareOrDownload(blob, `sunglasses-${stamp()}.${ext}`));
      };
      rec.stop();
    });
  }
}

async function shareOrDownload(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
      // Sharing failed (e.g. lost user activation) — fall back to download.
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'saved';
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
