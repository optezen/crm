import type { ReactNode } from 'react';
export function Card({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section className="card"><header><h2>{title}</h2>{description && <p>{description}</p>}</header>{children}</section>;
}
