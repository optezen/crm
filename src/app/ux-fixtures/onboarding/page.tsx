import { Wizard } from '../../onboarding/Wizard';
/** The real onboarding wizard without a session (the real route redirects to sign-in). Nothing can be saved from here: it is shown as "blocked". */
export default function Page() { return <main className="center"><Wizard blocked="Test fixture: nothing is saved." aiAvailable={false} /></main>; }
