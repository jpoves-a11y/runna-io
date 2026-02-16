// Wake Lock + silent audio fallback to keep screen on during GPS tracking
// Works on iOS Safari 16.4+ (Wake Lock API) and falls back to silent audio for older devices

let wakeLockSentinel: WakeLockSentinel | null = null;
let audioCtx: AudioContext | null = null;
let silentSource: AudioBufferSourceNode | null = null;
let silentInterval: number | null = null;

export async function acquireWakeLock(): Promise<boolean> {
  // Try Screen Wake Lock API first (iOS 16.4+, Chrome, Edge)
  if ('wakeLock' in navigator) {
    try {
      wakeLockSentinel = await (navigator as any).wakeLock.request('screen');
      wakeLockSentinel?.addEventListener('release', () => {
        console.log('[WakeLock] Released');
        wakeLockSentinel = null;
      });
      console.log('[WakeLock] Screen Wake Lock acquired');
      return true;
    } catch (e) {
      console.warn('[WakeLock] Failed to acquire Wake Lock:', e);
    }
  }

  // Fallback: silent audio loop (keeps iOS page alive)
  try {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate, audioCtx.sampleRate);

    const playSilence = () => {
      if (!audioCtx || audioCtx.state === 'closed') return;
      silentSource = audioCtx.createBufferSource();
      silentSource.buffer = buffer;
      silentSource.connect(audioCtx.destination);
      silentSource.loop = false;
      silentSource.start();
    };

    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }

    playSilence();
    silentInterval = window.setInterval(playSilence, 10000);
    console.log('[WakeLock] Silent audio fallback started');
    return true;
  } catch (e) {
    console.warn('[WakeLock] Silent audio fallback failed:', e);
    return false;
  }
}

export async function releaseWakeLock(): Promise<void> {
  if (wakeLockSentinel) {
    try { await wakeLockSentinel.release(); } catch (_) {}
    wakeLockSentinel = null;
  }
  if (silentInterval) {
    window.clearInterval(silentInterval);
    silentInterval = null;
  }
  if (silentSource) {
    try { silentSource.stop(); } catch (_) {}
    silentSource = null;
  }
  if (audioCtx) {
    try { await audioCtx.close(); } catch (_) {}
    audioCtx = null;
  }
  console.log('[WakeLock] All locks released');
}

// Re-acquire wake lock when page becomes visible again (iOS releases it on blur)
export function setupVisibilityReacquire(): () => void {
  const handler = async () => {
    if (document.visibilityState === 'visible' && !wakeLockSentinel) {
      console.log('[WakeLock] Page visible again, re-acquiring...');
      await acquireWakeLock();
    }
  };
  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
}
