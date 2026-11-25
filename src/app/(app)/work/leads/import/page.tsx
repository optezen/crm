import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCrmContext, leadsModuleActive } from '../../../../../lib/crm/context';
import { ActionForm } from '../../../../../components/ui/ActionForm';
import { Card } from '../../../../../components/ui/Card';
import { importLeadsAction } from '../actions';

export const maxDuration = 60;
export default async function ImportLeads() {
  const ctx = await getCrmContext(); if (!ctx || !(await leadsModuleActive())) notFound();
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Leads</span><h1>Import leads</h1><p className="muted">Upload a spreadsheet saved as CSV. Each row becomes a lead, exactly as if you had added it by hand. A phone or email that already exists is reused, not duplicated.</p></div></div>
    <Card title="1. Prepare your file">
      <ul className="stack" style={{ gap: 6, margin: 0, paddingLeft: 18 }}>
        <li>Columns: <strong>Name</strong> (required), Phone, Email, Source, Stage, Notes. Other columns are ignored.</li>
        <li>Source: walk_in, phone, website, whatsapp, referral, meta_ads or other. Stage must match your pipeline: {ctx.stages.join(', ')}.</li>
        <li>In Excel use File → Save As → <strong>CSV UTF-8</strong>. Up to 500 leads at a time.</li>
      </ul>
      <p><a className="btn" href="/leads-template.csv" download>Download the template</a></p>
    </Card>
    <Card title="2. Upload">
      <ActionForm action={importLeadsAction} submit="Import leads" resetOnSuccess>
        <label>CSV file<input className="input" type="file" name="file" accept=".csv,text/csv" required /></label>
      </ActionForm>
    </Card>
    <p><Link href="/work/leads">Back to leads</Link></p>
  </div>;
}
