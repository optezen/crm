'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from './ui/Card';
import { callOps } from '../app/(app)/work/ops-actions';
import { MODULE_LABEL, PERM_ACTIONS, PERM_MODULES, SCOPES, SCOPE_MODULES, permDefault } from '../lib/permissions/defaults';

export type RoleRow = { id: string; name: string; base_role: 'admin' | 'manager' | 'employee'; permissions: Record<string, Record<string, boolean>>; scopes: Record<string, string>; location_restricted: boolean };
export type DirRow = { user_id: string; email: string; role: string; custom_role_id: string | null; active: boolean; branches: string[] };
type Msg = { ok: boolean; text: string } | undefined;

function RoleEditor({ initial, customModules, isOwner, onDone }: { initial: RoleRow | null; customModules: { key: string; label: string }[]; isOwner: boolean; onDone: () => void }) {
  const [name, setName] = useState(initial?.name ?? ''), [base, setBase] = useState<RoleRow['base_role']>(initial?.base_role ?? 'employee'), [perms, setPerms] = useState(initial?.permissions ?? {}), [scopes, setScopes] = useState(initial?.scopes ?? {}), [loc, setLoc] = useState(initial?.location_restricted ?? false);
  const [pending, start] = useTransition(); const [msg, setMsg] = useState<Msg>();
  const modules = [...PERM_MODULES.map(m => ({ key: m as string, label: MODULE_LABEL[m]! })), ...customModules.map(c => ({ key: `custom:${c.key}`, label: `${c.label} (custom module)` }))];
  const eff = (m: string, a: string) => (perms[m]?.[a] ?? permDefault(base, m, a));
  const toggle = (m: string, a: string, v: boolean) => setPerms({ ...perms, [m]: { ...(perms[m] ?? {}), [a]: v } });
  const save = () => start(async () => {
    // only explicit DENIALS are stored: a role can narrow its base role, never widen it
    const clean: Record<string, Record<string, boolean>> = {}; for (const m of modules) for (const a of PERM_ACTIONS) { if (perms[m.key]?.[a] === false && permDefault(base, m.key, a) && (!['contacts', 'billing_contacts'].includes(m.key) || a === 'view')) (clean[m.key] ??= {})[a] = false; }
    const sc: Record<string, string> = {}; for (const [k, v] of Object.entries(scopes)) if (v && v !== 'all') sc[k] = v;
    const r = await callOps('role_save', { p_id: initial?.id ?? null, p_name: name, p_base: base, p_permissions: clean, p_scopes: sc, p_location_restricted: loc }, 'Role saved.'); setMsg({ ok: r.ok, text: r.ok ? r.message : r.error }); if (r.ok) onDone();
  });
  return <div className="stack" style={{ gap: 12 }}>
    <div className="form-grid"><div className="field"><label htmlFor="rn">Role name</label><input id="rn" className="input" value={name} maxLength={40} onChange={e => setName(e.target.value)} /></div>
      <div className="field"><label htmlFor="rb">Starts from</label><select id="rb" className="input" value={base} disabled={!!initial} onChange={e => { setBase(e.target.value as RoleRow['base_role']); setPerms({}); }}><option value="employee">Employee</option><option value="manager">Manager</option>{isOwner && <option value="admin">Admin</option>}</select></div></div>
    <p className="muted">A custom role can only <strong>remove</strong> abilities its starting role already has. Untick a box to deny that action; ticked boxes that look greyed out are not available to the starting role.</p>
    <div className="table-wrap" role="region" aria-label="Permissions" tabIndex={0}><table><thead><tr><th scope="col">Module</th>{PERM_ACTIONS.map(a => <th key={a} scope="col">{a}</th>)}<th scope="col">Can see</th></tr></thead>
      <tbody>{modules.map(m => <tr key={m.key}><td>{m.label}</td>{PERM_ACTIONS.map(a => { const can = permDefault(base, m.key, a) && (!['contacts', 'billing_contacts'].includes(m.key) || a === 'view'); return <td key={a}><input type="checkbox" aria-label={`${m.label} ${a}`} disabled={!can} checked={can && eff(m.key, a)} onChange={e => toggle(m.key, a, e.target.checked)} /></td>; })}
        <td>{SCOPE_MODULES.includes(m.key) || m.key.startsWith('custom:') ? <select className="input" aria-label={`${m.label} visibility`} style={{ minWidth: 150 }} value={scopes[m.key] ?? 'all'} onChange={e => setScopes({ ...scopes, [m.key]: e.target.value })}>{SCOPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select> : <span className="muted">—</span>}</td></tr>)}</tbody></table></div>
    <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={loc} onChange={e => setLoc(e.target.checked)} /> Only use stock locations that belong to the member’s own branches (locations with no branch stay shared)</label>
    <div className="row"><button type="button" className="btn primary" disabled={pending || !name.trim()} onClick={save}>Save role</button>{msg && <span role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'ok' : 'err'}>{msg.text}</span>}</div></div>;
}

export function RolesManager({ roles, directory, branches, locations, customModules, isOwner, selfId }: { roles: RoleRow[]; directory: DirRow[]; branches: { id: string; name: string; active: boolean }[]; locations: { id: string; name: string; branch_id: string | null }[]; customModules: { key: string; label: string }[]; isOwner: boolean; selfId: string }) {
  const router = useRouter(); const [edit, setEdit] = useState<RoleRow | 'new' | null>(null); const [pending, start] = useTransition(); const [msg, setMsg] = useState<Msg>(); const [bn, setBn] = useState('');
  const run = (fn: string, args: Record<string, unknown>, ok: string) => start(async () => { const r = await callOps(fn, args, ok); setMsg({ ok: r.ok, text: r.ok ? r.message : r.error }); if (r.ok) router.refresh(); });
  return <div className="stack">
    {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'ok' : 'err'}>{msg.text}</p>}
    <Card title="Custom roles" description="Default roles (owner, admin, manager, employee) keep working exactly as before. Custom roles refine them.">
      {roles.length === 0 && <p className="muted">No custom roles yet.</p>}
      {roles.map(r => <div className="task" key={r.id}><div className="row"><strong>{r.name}</strong><span className="badge">starts from {r.base_role}</span><span className="muted">{directory.filter(d => d.custom_role_id === r.id).length} member(s)</span>
        <button type="button" className="btn" onClick={() => setEdit(r)}>Edit</button><button type="button" className="btn" disabled={pending} onClick={() => { if (confirm(`Delete the role "${r.name}"?`)) run('role_delete', { p_id: r.id }, 'Role deleted.'); }}>Delete</button></div></div>)}
      <div><button type="button" className="btn primary" onClick={() => setEdit('new')}>Create a role</button></div>
      {edit && <div key={edit === 'new' ? 'new' : edit.id}><RoleEditor initial={edit === 'new' ? null : edit} customModules={customModules} isOwner={isOwner} onDone={() => { setEdit(null); router.refresh(); }} /></div>}</Card>
    <Card title="Who has which role" description="Changing a member's role changes what they can see and do immediately. You cannot change your own role or the owner's.">
      <div className="table-wrap" role="region" aria-label="Team roles" tabIndex={0}><table><thead><tr><th scope="col">Member</th><th scope="col">Role</th><th scope="col">Branches</th></tr></thead>
        <tbody>{directory.map(m => <tr key={m.user_id}><td>{m.email}{m.user_id === selfId && ' (you)'}</td>
          <td>{m.role === 'owner' || m.user_id === selfId ? <span className="badge">{m.role}</span> : <select className="input" aria-label={`Role of ${m.email}`} value={m.custom_role_id ? `c:${m.custom_role_id}` : `b:${m.role}`} disabled={pending} onChange={e => { const v = e.target.value; run('member_assign_role', v.startsWith('c:') ? { p_user: m.user_id, p_custom_role: v.slice(2), p_base_if_cleared: 'employee' } : { p_user: m.user_id, p_custom_role: null, p_base_if_cleared: v.slice(2) }, 'Role updated.'); }}>
            {(['employee', 'manager', ...(isOwner ? ['admin'] : [])] as string[]).map(b => <option key={b} value={`b:${b}`}>{b}</option>)}{m.role === 'admin' && !isOwner && <option value="b:admin" disabled>admin</option>}{roles.filter(r => isOwner || r.base_role !== 'admin').map(r => <option key={r.id} value={`c:${r.id}`}>{r.name} ({r.base_role}+)</option>)}</select>}</td>
          <td><div className="row" style={{ gap: 10 }}>{branches.filter(b => b.active).map(b => <label key={b.id} className="row" style={{ gap: 4 }}><input type="checkbox" checked={m.branches.includes(b.id)} disabled={pending} onChange={e => run('member_branches_set', { p_user: m.user_id, p_branches: e.target.checked ? [...m.branches, b.id] : m.branches.filter(x => x !== b.id) }, 'Branches updated.')} /> {b.name}</label>)}{branches.length === 0 && <span className="muted">—</span>}</div></td></tr>)}</tbody></table></div></Card>
    <Card title="Branches and locations (optional)" description="Branches group people and stock locations. They power the “branch team” visibility and location restrictions. Skip this if you do not need it.">
      <div className="stack" style={{ gap: 10 }}>
        {branches.map(b => <div className="row" key={b.id}><strong>{b.name}</strong>{!b.active && <span className="badge done">inactive</span>}<button type="button" className="btn" disabled={pending} onClick={() => run('branch_save', { p_id: b.id, p_name: b.name, p_active: !b.active }, 'Branch updated.')}>{b.active ? 'Deactivate' : 'Activate'}</button></div>)}
        <form className="inline" onSubmit={e => { e.preventDefault(); if (bn.trim()) { run('branch_save', { p_id: null, p_name: bn, p_active: true }, 'Branch added.'); setBn(''); } }}><div className="field"><label htmlFor="bn">New branch</label><input id="bn" className="input" value={bn} maxLength={80} onChange={e => setBn(e.target.value)} /></div><button className="btn" disabled={pending || !bn.trim()}>Add branch</button></form>
        {locations.length > 0 && <div className="stack" style={{ gap: 6 }}><strong>Stock locations</strong>{locations.map(l => <div className="row" key={l.id}><span style={{ minWidth: 160 }}>{l.name}</span><select className="input" aria-label={`Branch of ${l.name}`} style={{ width: 'auto' }} value={l.branch_id ?? ''} disabled={pending} onChange={e => run('location_branch_set', { p_location: l.id, p_branch: e.target.value || null }, 'Location updated.')}><option value="">Shared (all branches)</option>{branches.filter(b => b.active).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>)}</div>}</div></Card>
  </div>;
}
