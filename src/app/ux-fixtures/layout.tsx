import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
export const dynamic = 'force-dynamic';
/** Browser-test fixtures: the REAL shell and view components with clearly labelled sample data, so layout, keyboard and accessibility can be tested in a real browser without a database.
 * Disabled unless OPTIZEN_UX_FIXTURES=1 (never set in production), so no sample data can ever appear in a real workspace. */
export default function FixturesLayout({ children }: { children: ReactNode }) { if (process.env.OPTIZEN_UX_FIXTURES !== '1') notFound(); return <>{children}</>; }
