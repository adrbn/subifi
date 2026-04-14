// Capture a still frame from a video file at a given time, for use as a
// thumbnail/cover in the project manifest. We create an off-DOM <video>
// element, seek to the target time, and draw the frame onto a canvas to
// read back a JPEG data URL.
//
// The JPEG output is capped at 320px wide (height follows aspect ratio)
// and quality 0.6 so the cover fits comfortably inside a ~25KB payload.

const COVER_MAX_WIDTH = 320;
const COVER_QUALITY = 0.6;
const COVER_TIME = 1.0; // seconds — avoids black intro frames

export async function captureCoverFrame(file: File): Promise<string | null> {
  if (typeof document === 'undefined') return null;
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      const onLoaded = () => resolve();
      const onError = () => reject(new Error('Video failed to load for cover'));
      video.addEventListener('loadedmetadata', onLoaded, { once: true });
      video.addEventListener('error', onError, { once: true });
    });
    const targetTime = Math.min(COVER_TIME, Math.max(0, video.duration - 0.1));
    await new Promise<void>((resolve, reject) => {
      const onSeeked = () => resolve();
      const onError = () => reject(new Error('Video seek failed'));
      video.addEventListener('seeked', onSeeked, { once: true });
      video.addEventListener('error', onError, { once: true });
      video.currentTime = targetTime;
    });
    const w = video.videoWidth || 640;
    const h = video.videoHeight || 360;
    const scale = Math.min(1, COVER_MAX_WIDTH / w);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', COVER_QUALITY);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
