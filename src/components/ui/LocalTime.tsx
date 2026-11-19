'use client';
import { useEffect, useState } from 'react';
/** Renders a timestamp in the viewer's own time zone (the server only knows UTC). */
export function LocalTime({ iso }: { iso: string }) {
  const [text, setText] = useState<string>();
  useEffect(() => setText(new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })), [iso]);
  return <time dateTime={iso}>{text ?? iso.slice(0, 10)}</time>;
}
