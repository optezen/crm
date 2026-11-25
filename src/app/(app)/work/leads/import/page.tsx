import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCrmContext, leadsModuleActive } from '../../../../../lib/crm/context';
import { ActionForm } from '../../../../../components/ui/ActionForm';
import { importLeadsAction } from '../actions';

export const maxDuration = 60;
export default async function ImportLeads() {
  const ctx = await getCrmContext(); if (!ctx || !(await leadsModuleActive())) notFound();
  return <div className="stack imp">
    <div><Link href="/work/leads" className="muted">← Leads</Link><h1 style={{ margin: '8px 0 4px' }}>Import leads</h1>
      <p className="muted" style={{ margin: 0 }}>Upload a CSV and every row becomes a lead. Existing phones and emails are reused.</p></div>
    <ActionForm action={importLeadsAction} submit="Import leads" resetOnSuccess>
      <label className="imp-drop"><strong>Choose your CSV file</strong><span className="muted">Up to 500 leads, 2 MB</span><input type="file" name="file" accept=".csv,text/csv" required /></label>
    </ActionForm>
    <div className="stack" style={{ gap: 8 }}>
      <span>Don&apos;t have a file yet? <a href="/leads-template.csv" download>Download the template</a>.</span>
      <details><summary>What should the file contain?</summary>
        <ul className="stack" style={{ gap: 6, margin: '8px 0 0', paddingLeft: 18 }}>
          <li><strong>Name</strong> is required. Phone, Email, Source, Stage and Notes are optional; other columns are ignored.</li>
          <li>Source: walk_in, phone, website, whatsapp, referral, meta_ads or other.</li>
          <li>Stage (blank = {ctx.stages[0]}): {ctx.stages.join(', ')}.</li>
          <li>From Excel: File → Save As → <strong>CSV UTF-8</strong>.</li></ul></details>
    </div>
  </div>;
}
