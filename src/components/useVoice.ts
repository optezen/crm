'use client';
// Microphone input for the assistant. Audio lives only in memory: it is uploaded once for transcription and discarded, never stored, played back or logged by Optizen.
// The transcript is handed to the caller to REVIEW AND EDIT; nothing is sent to the assistant automatically. Typing always remains available.
import { useCallback, useEffect, useRef, useState } from 'react';

export type VoiceState = 'idle' | 'requesting' | 'recording' | 'transcribing';
const MAX_SECONDS = 120;
const pickMime = () => { if (typeof MediaRecorder === 'undefined') return null; return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find(t => MediaRecorder.isTypeSupported(t)) ?? ''; };
export const voiceSupported = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && pickMime() !== null;

export function useVoice(onTranscript: (text: string) => void) {
  const [state, setState] = useState<VoiceState>('idle'); const [seconds, setSeconds] = useState(0); const [error, setError] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null); const chunks = useRef<Blob[]>([]); const stream = useRef<MediaStream | null>(null); const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const abort = useRef<AbortController | null>(null); const cancelled = useRef(false); const secs = useRef(0);
  const release = useCallback(() => { if (timer.current) clearInterval(timer.current); timer.current = null; stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; rec.current = null; chunks.current = []; }, []);
  useEffect(() => () => { cancelled.current = true; abort.current?.abort(); try { rec.current?.stop(); } catch { /* already stopped */ } release(); }, [release]);

  const upload = useCallback(async (blob: Blob, seconds: number) => {
    setState('transcribing'); abort.current = new AbortController();
    try {
      const f = new FormData(); f.append('audio', blob, 'speech'); f.append('seconds', String(seconds));
      const res = await fetch('/api/ai/transcribe', { method: 'POST', body: f, signal: abort.current.signal });
      const body = await res.json().catch(() => null) as { ok?: boolean; text?: string; message?: string } | null;
      if (!res.ok || !body?.ok || !body.text) setError(body?.message ?? 'Voice input failed. You can type your message instead.'); else onTranscript(body.text);
    } catch (e) { if ((e as Error).name !== 'AbortError') setError('Could not reach the server. You can type your message instead.'); }
    finally { setState('idle'); }
  }, [onTranscript]);

  const start = useCallback(async () => {
    setError(null); if (!voiceSupported()) { setError('Voice input is not supported in this browser. Please type your message.'); return; }
    setState('requesting'); cancelled.current = false;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.current = s; const mime = pickMime() ?? '';
      const r = new MediaRecorder(s, mime ? { mimeType: mime } : undefined); rec.current = r; chunks.current = []; secs.current = 0; setSeconds(0);
      r.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data); };
      r.onerror = () => { setError('The recording failed. Please type your message.'); release(); setState('idle'); };
      r.onstop = () => { const blob = new Blob(chunks.current, { type: r.mimeType || mime || 'audio/webm' }); const n = secs.current; release(); if (cancelled.current) { setState('idle'); return; } if (blob.size < 400) { setError('Nothing was recorded. Try again.'); setState('idle'); return; } void upload(blob, n); };
      r.start(); setState('recording');
      timer.current = setInterval(() => { secs.current += 1; setSeconds(secs.current); if (secs.current >= MAX_SECONDS) { try { r.stop(); } catch { /* already stopped */ } } }, 1000);
    } catch (e) {
      release(); setState('idle'); const n = (e as DOMException)?.name;
      setError(n === 'NotAllowedError' || n === 'SecurityError' ? 'Microphone access was blocked. Allow it in your browser, or type your message.' : n === 'NotFoundError' ? 'No microphone was found. Please type your message.' : 'The microphone could not be started. Please type your message.');
    }
  }, [release, upload]);
  const stop = useCallback(() => { cancelled.current = false; try { rec.current?.stop(); } catch { release(); setState('idle'); } }, [release]);
  /** Throws the recording away without uploading it, or aborts a transcription in flight. */
  const cancel = useCallback(() => { cancelled.current = true; abort.current?.abort(); try { if (rec.current && rec.current.state !== 'inactive') rec.current.stop(); } catch { /* ignore */ } release(); setState('idle'); setSeconds(0); }, [release]);
  return { state, seconds, error, start, stop, cancel, clearError: () => setError(null), maxSeconds: MAX_SECONDS };
}
