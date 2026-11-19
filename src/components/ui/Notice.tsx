import type { ReactNode } from 'react';
export function Notice({ title, children }: { title: string; children: ReactNode }) {
  return <div className="notice" role="status"><strong>{title}</strong>{children}</div>;
}
