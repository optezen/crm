import { notFound } from 'next/navigation';
import { getCrmContext, leadsModuleActive } from '../../../../../lib/crm/context';
import { isManager, listMembers } from '../../../../../lib/crm/service';
import { ActionForm } from '../../../../../components/ui/ActionForm';
import { Card } from '../../../../../components/ui/Card';
import { LeadFields } from '../LeadFields';
import { createLeadAction } from '../actions';

export default async function NewLead() {
  const ctx = await getCrmContext(); if (!ctx || !(await leadsModuleActive())) notFound();
  const mem = await listMembers(ctx);
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Optizen Work mode</span><h1>New lead</h1><p className="muted">A contact with the same phone or email is reused instead of duplicated.</p></div></div>
    <Card title="Lead details">
      <ActionForm action={createLeadAction} submit="Create lead">
        <LeadFields stages={ctx.stages} members={mem.ok ? mem.value : []} userId={ctx.userId} manager={isManager(ctx.role)} />
      </ActionForm>
    </Card>
  </div>;
}
