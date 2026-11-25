import Link from 'next/link';
import { Frame } from '../fixture';
import { ModuleBar } from '../../../components/crm/ModuleBar';
import { LeadsTable } from '../../../components/crm/LeadsTable';
import { StageStepper } from '../../../components/crm/StageStepper';

/** Sample rows only. This route exists when OPTIZEN_UX_FIXTURES=1 so the lead list and record chrome can be seen without a database. */
export default function Page() {
  const rows = [
    { id: 'a1', name: 'Asha Rao', summary: 'Wants a demo this week', phone: '+919845012345', email: 'asha@example.com', hidden: false, stage: 'New', source: 'Website', owner: 'Me', ago: '2h ago', tasks: 1, due: { text: 'Today', tone: 'today' } },
    { id: 'a2', name: 'Ben Joseph', summary: null, phone: '+919800000002', email: 'ben@example.com', hidden: false, stage: 'Qualified', source: 'Referral', owner: 'Priya', ago: '1d ago', tasks: 0, due: { text: 'Overdue', tone: 'late' } },
    { id: 'a3', name: 'Chitra Menon', summary: 'Asked for pricing', phone: null, email: 'chitra@example.com', hidden: false, stage: 'New', source: 'Walk-in', owner: 'Unassigned', ago: '4d ago', tasks: 0, due: null },
  ];
  return <Frame>
    <div className="stack lt-page">
      <ModuleBar title="Leads" meta="3 records" view="list" actions={<><Link className="btn" href="/work/leads/import">Import</Link><Link className="btn primary" href="/work/leads/new">Create Lead</Link></>} />
      <nav className="tabs" aria-label="Filter by stage"><Link href="/ux-fixtures/leads" aria-current="page">All<span>3</span></Link><Link href="/ux-fixtures/leads">New<span>2</span></Link><Link href="/ux-fixtures/leads">Qualified<span>1</span></Link></nav>
      <LeadsTable rows={rows} stages={['New', 'Qualified', 'Won']} owners={[{ id: '1', label: 'Me' }]} manager sort={{ by: 'created', dir: 'desc', name: '/ux-fixtures/leads', updated: '/ux-fixtures/leads' }} />
    </div>
    <div className="stack zrec" style={{ marginTop: 28 }}>
      <div><Link className="crumb" href="/ux-fixtures/leads">Leads</Link></div>
      <div className="ld-head"><div className="lt-av ld-av" aria-hidden>AR</div><div className="grow"><h1 style={{ margin: 0 }}>Asha Rao</h1><p className="muted" style={{ margin: '4px 0 0' }}>Website · Owner: Me</p></div><div className="row"><a className="btn primary" href="tel:+919845012345">Call</a><a className="btn" href="mailto:asha@example.com">Email</a></div></div>
      <StageStepper leadId="a1" stages={['New', 'Qualified', 'Won']} current="Qualified" />
      <section className="card"><h2>Lead information</h2><div className="zfields"><div><span>Phone</span><strong>+919845012345</strong></div><div><span>Email</span><strong>asha@example.com</strong></div><div><span>Source</span><strong>Website</strong></div><div><span>Stage</span><strong>Qualified</strong></div><div className="wide"><span>Needs</span><strong>Wants a demo this week</strong></div></div></section>
    </div>
  </Frame>;
}
