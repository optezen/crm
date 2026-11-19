import type { ReactNode } from 'react';
import './globals.css';
export const metadata = { title: 'Optizen — Configuration Studio', description: 'AI-first configurable business operating system' };
export default function RootLayout({ children }: { children: ReactNode }) { return <html lang="en"><body>{children}</body></html>; }
