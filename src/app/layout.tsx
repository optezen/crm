import type { ReactNode } from 'react';
import { Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';
const sans = Plus_Jakarta_Sans({ subsets: ['latin'], weight: ['400', '500', '600', '700'], display: 'swap', variable: '--font-sans' });
export const metadata = { title: 'Optizen — Configuration Studio', description: 'AI-first configurable business operating system' };
export default function RootLayout({ children }: { children: ReactNode }) { return <html lang="en" className={sans.variable}><body>{children}</body></html>; }
