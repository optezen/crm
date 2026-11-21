import { notFound } from 'next/navigation';
import { getWorkspaceState } from '../../../../../lib/workspace/service';
import { activeFields, findModule } from '../../../../../lib/records/validate';
import { ActionForm } from '../../../../../components/ui/ActionForm';
import { Card } from '../../../../../components/ui/Card';
import { FormFields } from '../../../../../components/ui/FormFields';
import { createRecordAction } from '../actions';

export default async function NewRecord({ params }: { params: Promise<{ module: string }> }) {
  const { module } = await params;
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  const m = findModule(s.config, module); if (!m) notFound();
  const fields = activeFields(m.object);
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Optizen Work mode</span><h1>Add to {m.module.label}</h1></div></div>
    <Card title="Details">
      {fields.length === 0 ? <p className="muted">No fields are defined for this module yet. An owner or admin can add them in Builder.</p>
        : <ActionForm action={createRecordAction} submit="Save record"><input type="hidden" name="module" value={module} />
            <FormFields fields={fields} /></ActionForm>}
    </Card>
  </div>;
}
