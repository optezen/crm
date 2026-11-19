'use server';
import { redirect } from 'next/navigation';
import { createWorkspace } from '../../lib/workspace/service';

export async function createWorkspaceAction(name: string, industry: string): Promise<{ error: string }> {
  const r = await createWorkspace({ name, industry }); // re-validated server-side
  if (!r.ok) return { error: r.error };
  redirect('/work');
}
