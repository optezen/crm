'use client';
/** One error screen for every page in the app: plain words, a way to retry, and no technical detail shown to users. */
export default function AppError({ reset }: { error: Error; reset: () => void }) {
  return <div className="notice" role="alert"><strong>Something went wrong on this screen</strong><p style={{ margin: '4px 0 12px' }}>Your data is safe. Try again; if it keeps happening, go back to your home screen.</p>
    <div className="row"><button type="button" className="btn primary" onClick={reset}>Try again</button><a className="btn" href="/work">Go to home</a></div></div>;
}
