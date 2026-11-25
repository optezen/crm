import { notFound } from 'next/navigation';
import { getCrmContext, leadsModuleActive } from '../../../../../lib/crm/context';
import { isManager, listMembers } from '../../../../../lib/crm/service';
import Link from 'next/link';
import { ModuleBar } from '../../../../../components/crm/ModuleBar';
import { ActionForm } from '../../../../../components/ui/ActionForm';
import { Card } from '../../../../../components/ui/Card';
import { LeadFields } from '../LeadFields';
import { createLeadAction } from '../actions';

export default async function NewLead() {
  const ctx = await getCrmContext(); if (!ctx || !(await leadsModuleActive())) notFound();
  const mem = await listMembers(ctx);
  return <div className="stack lt-page">
    <ModuleBar title="Create Lead" meta="A contact with the same phone or email is reused instead of duplicated." actions={<Link className="btn" href="/work/leads">Cancel</Link>} />
    <Card title="Lead details">
      <ActionForm action={createLeadAction} submit="Create lead">
        <LeadFields stages={ctx.stages} members={mem.ok ? mem.value : []} userId={ctx.userId} manager={isManager(ctx.role)} />
      </ActionForm>
    </Card>
  </div>;
}
