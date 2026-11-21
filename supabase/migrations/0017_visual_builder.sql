-- 0017 Visual Builder.
-- Layout metadata is stored apart from the executable definition: it never reaches automation_validate or the engine.
-- All writes are functions; the actor and organization come from the signed-in membership.

-- ---------- workflow canvas layout ----------
create table public.automation_layouts (
  workflow_id uuid primary key,
  organization_id uuid not null,
  layout jsonb not null check (jsonb_typeof(layout) = 'object' and pg_column_size(layout) <= 16384),
  updated_by uuid not null, updated_at timestamptz not null default now(),
  foreign key (workflow_id, organization_id) references public.automation_workflows (id, organization_id) on delete cascade
);
alter table public.automation_layouts enable row level security;
create policy automation_layouts_read on public.automation_layouts for select to authenticated using (public.org_role(organization_id) in ('owner','admin'));
revoke all on public.automation_layouts from anon, authenticated;
grant select on public.automation_layouts to authenticated;

-- Shape check only (ids, finite coordinates, bounded size). Layout never influences execution.
create or replace function public.automation_layout_validate(p jsonb) returns void language plpgsql immutable set search_path = '' as $$
declare k text; v jsonb;
begin
  if p is null then return; end if;
  if jsonb_typeof(p) <> 'object' or pg_column_size(p) > 16384 then raise exception 'The canvas layout is invalid.' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_object_keys(p) x where x <> all (array['v','order','pos','view'])) then raise exception 'The canvas layout is invalid.' using errcode = '22023'; end if;
  if p ? 'order' then
    if jsonb_typeof(p->'order') <> 'array' or jsonb_array_length(p->'order') > 40
       or exists (select 1 from jsonb_array_elements(p->'order') e where jsonb_typeof(e.value) <> 'string' or e.value #>> '{}' !~ '^[a-z0-9_-]{1,24}$') then
      raise exception 'The canvas layout is invalid.' using errcode = '22023'; end if;
  end if;
  if p ? 'pos' then
    if jsonb_typeof(p->'pos') <> 'object' then raise exception 'The canvas layout is invalid.' using errcode = '22023'; end if;
    for k, v in select * from jsonb_each(p->'pos') loop
      if k !~ '^[a-z0-9_-]{1,24}$' or jsonb_typeof(v) <> 'object' or jsonb_typeof(v->'x') <> 'number' or jsonb_typeof(v->'y') <> 'number'
         or abs((v->>'x')::numeric) > 100000 or abs((v->>'y')::numeric) > 100000 then raise exception 'The canvas layout is invalid.' using errcode = '22023'; end if;
    end loop;
  end if;
  if p ? 'view' then
    if jsonb_typeof(p->'view') <> 'object' or jsonb_typeof(p->'view'->'x') <> 'number' or jsonb_typeof(p->'view'->'y') <> 'number' or jsonb_typeof(p->'view'->'z') <> 'number'
       or abs((p->'view'->>'x')::numeric) > 1000000 or abs((p->'view'->>'y')::numeric) > 1000000 or (p->'view'->>'z')::numeric not between 0.1 and 4 then
      raise exception 'The canvas layout is invalid.' using errcode = '22023'; end if;
  end if;
end $$;

-- A token that changes whenever the saved draft (or workflow name) changes. 'none' = no draft exists.
create or replace function public.automation_draft_token(p_org uuid, p_workflow uuid) returns text language plpgsql stable security definer set search_path = '' as $$
declare v_t text;
begin
  if public.crm_member_role(p_org) not in ('owner','admin') then raise exception 'Only owners and admins can manage automations.' using errcode = '42501'; end if;
  select md5(w.name || '|' || v.definition::text) into v_t from public.automation_workflows w
    join public.automation_workflow_versions v on v.workflow_id = w.id and v.status = 'draft' where w.id = p_workflow and w.organization_id = p_org;
  return coalesce(v_t, 'none');
end $$;

-- Visual save: the same validation and storage as automation_save_draft, plus layout metadata and optimistic concurrency.
-- p_expected_token: the token the editor loaded ('none' when it opened a published workflow with no draft; null for a brand-new workflow).
-- p_expected_published: the published version the editor was based on (null = none).
create or replace function public.automation_save_visual(p_org uuid, p_workflow uuid, p_name text, p_definition jsonb, p_layout jsonb, p_expected_token text, p_expected_published integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_id uuid; v_pub integer;
begin
  if public.crm_member_role(p_org) not in ('owner','admin') then raise exception 'Only owners and admins can manage automations.' using errcode = '42501'; end if;
  perform public.automation_layout_validate(p_layout);
  if p_workflow is not null then
    perform pg_advisory_xact_lock(hashtext('automation:' || p_org::text));
    select published_version into v_pub from public.automation_workflows where id = p_workflow and organization_id = p_org;
    if not found then raise exception 'Automation not found.' using errcode = 'P0002'; end if;
    if p_expected_token is null or p_expected_token is distinct from public.automation_draft_token(p_org, p_workflow) or p_expected_published is distinct from v_pub then
      raise exception 'This automation changed since you opened it (it was saved or published elsewhere). Reload it to see the latest version; your edits were not saved.' using errcode = '22023'; end if;
  end if;
  v_id := public.automation_save_draft(p_org, p_workflow, p_name, p_definition);
  if p_layout is not null then
    insert into public.automation_layouts (workflow_id, organization_id, layout, updated_by) values (v_id, p_org, p_layout, v_uid)
      on conflict (workflow_id) do update set layout = excluded.layout, updated_by = excluded.updated_by, updated_at = now(); end if;
  return jsonb_build_object('id', v_id, 'token', public.automation_draft_token(p_org, v_id));
end $$;

revoke all on function public.automation_layout_validate(jsonb), public.automation_draft_token(uuid, uuid), public.automation_save_visual(uuid, uuid, text, jsonb, jsonb, text, integer) from public, anon, authenticated;
grant execute on function public.automation_draft_token(uuid, uuid), public.automation_save_visual(uuid, uuid, text, jsonb, jsonb, text, integer) to authenticated;

-- ---------- configuration: form sections/help text, stage settings and stage migration plans ----------
-- Field `description` (<=200) and `section` (<=40); pipeline `stageSettings` (color + transition requirements) and `stageMoves` (migration plan).
-- The previous validator (core + operations) is kept and wrapped, so every existing caller (create / save / publish / restore) is covered.
alter function public.validate_workspace_definition(jsonb) rename to validate_workspace_definition_pre_visual;

create or replace function public.visual_validate(p jsonb) returns void language plpgsql immutable set search_path = '' as $$
declare o jsonb; f jsonb; v_stages jsonb := p #> '{pipeline,stages}'; k text; v jsonb; m jsonb; v_from text[] := '{}';
begin
  for o in select * from jsonb_array_elements(p->'objects') loop
    for f in select * from jsonb_array_elements(o->'fields') loop
      if f ? 'description' and (jsonb_typeof(f->'description') <> 'string' or char_length(f->>'description') > 200) then
        raise exception 'Field "%" has an invalid description (up to 200 characters).', f->>'key' using errcode = '22023'; end if;
      if f ? 'section' and (jsonb_typeof(f->'section') <> 'string' or char_length(btrim(f->>'section')) > 40) then
        raise exception 'Field "%" has an invalid section (up to 40 characters).', f->>'key' using errcode = '22023'; end if;
    end loop;
  end loop;
  if p #> '{pipeline}' ? 'stageSettings' then
    if jsonb_typeof(p #> '{pipeline,stageSettings}') <> 'object' or (select count(*) from jsonb_object_keys(p #> '{pipeline,stageSettings}')) > 20 then raise exception 'Stage settings are invalid.' using errcode = '22023'; end if;
    for k, v in select * from jsonb_each(p #> '{pipeline,stageSettings}') loop
      if not v_stages @> to_jsonb(k) or jsonb_typeof(v) <> 'object' or exists (select 1 from jsonb_object_keys(v) x where x not in ('color','requires_assignee','requires_summary'))
         or (v ? 'color' and (jsonb_typeof(v->'color') <> 'string' or v->>'color' not in ('gray','green','blue','amber','red','purple')))
         or (v ? 'requires_assignee' and jsonb_typeof(v->'requires_assignee') <> 'boolean') or (v ? 'requires_summary' and jsonb_typeof(v->'requires_summary') <> 'boolean') then
        raise exception 'The settings for stage "%" are invalid.', k using errcode = '22023'; end if;
    end loop;
  end if;
  if p #> '{pipeline}' ? 'stageMoves' then
    if jsonb_typeof(p #> '{pipeline,stageMoves}') <> 'array' or jsonb_array_length(p #> '{pipeline,stageMoves}') > 20 then raise exception 'Stage moves are invalid.' using errcode = '22023'; end if;
    for m in select * from jsonb_array_elements(p #> '{pipeline,stageMoves}') loop
      if jsonb_typeof(m) <> 'object' or exists (select 1 from jsonb_object_keys(m) x where x not in ('from','to')) or jsonb_typeof(m->'from') <> 'string' or jsonb_typeof(m->'to') <> 'string'
         or v_stages @> to_jsonb(m->>'from') or not v_stages @> to_jsonb(m->>'to') or (m->>'from') = any(v_from) then
        raise exception 'A stage move is invalid: it must move leads out of a stage the pipeline no longer has, into one it does.' using errcode = '22023'; end if;
      v_from := array_append(v_from, m->>'from');
    end loop;
  end if;
end $$;

create or replace function public.validate_workspace_definition(p jsonb) returns void language plpgsql stable set search_path = '' as $$
begin
  perform public.validate_workspace_definition_pre_visual(p);
  perform public.visual_validate(p);
end $$;
revoke all on function public.validate_workspace_definition(jsonb), public.visual_validate(jsonb) from public, anon, authenticated;

-- Publishing applies the draft's stage migration plan in the same transaction: leads in a stage the new pipeline drops move to the planned stage,
-- each with a visible stage_changed activity and an audit event. Without a plan, removing a stage that still holds leads is refused exactly as before.
-- The plan is removed from the definition before it becomes the (immutable) published version, so a stale plan can never be re-applied later.
create or replace function public.publish_workspace_config(p_org uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_draft public.workspace_configuration_versions; v_stage text; v_n bigint; mv jsonb; v_moved jsonb := '[]'::jsonb; v_cnt integer;
begin
  if public.crm_member_role(p_org) not in ('owner','admin') then raise exception 'Only owners and admins can edit the workspace configuration.' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('ws:' || p_org::text));
  select * into v_draft from public.workspace_configuration_versions where organization_id = p_org and status = 'draft' for update;
  if not found then raise exception 'There is no saved draft to publish.' using errcode = '22023'; end if;
  perform public.validate_workspace_definition(v_draft.definition);
  perform public.workspace_check_data_protection(p_org, v_draft.definition);
  for mv in select * from jsonb_array_elements(coalesce(v_draft.definition #> '{pipeline,stageMoves}', '[]'::jsonb)) loop
    with moved as (update public.leads set stage = mv->>'to', updated_at = now() where organization_id = p_org and stage = mv->>'from' returning id)
    insert into public.lead_activities (organization_id, lead_id, actor_id, kind, body, meta)
      select p_org, id, (select auth.uid()), 'stage_changed', null, jsonb_build_object('from', mv->>'from', 'to', mv->>'to', 'reason', 'pipeline_migration', 'revision', v_draft.revision) from moved;
    get diagnostics v_cnt = row_count;
    v_moved := v_moved || jsonb_build_array(jsonb_build_object('from', mv->>'from', 'to', mv->>'to', 'leads', v_cnt));
  end loop;
  select l.stage, count(*) into v_stage, v_n from public.leads l
    where l.organization_id = p_org and not coalesce(v_draft.definition#>'{pipeline,stages}' @> to_jsonb(l.stage), false)
    group by l.stage order by count(*) desc limit 1;
  if v_stage is not null then
    raise exception '% lead(s) are still in the stage "%", which the new pipeline removes. Move them to another stage first, or plan the move in the Pipeline builder.', v_n, v_stage using errcode = '22023'; end if;
  update public.workspace_configuration_versions set definition = definition #- '{pipeline,stageMoves}' where id = v_draft.id;
  update public.workspace_configuration_versions set status = 'archived' where organization_id = p_org and status = 'published';
  update public.workspace_configuration_versions set status = 'published' where id = v_draft.id;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'workspace.published', jsonb_build_object('revision', v_draft.revision, 'stage_moves', v_moved));
  perform public.crm_emit(p_org, 'workspace.published', 'workspace', p_org, jsonb_build_object('revision', v_draft.revision));
  return v_draft.revision;
end $$;

-- Transition requirements are enforced where a lead MOVES into a stage (the database is the gate; the kanban and forms only explain it).
create or replace function public.crm_set_stage(p_org uuid, p_lead uuid, p_stage text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_lead public.leads := public.crm_lock_lead(p_org, p_lead, public.crm_member_role(p_org)); v_stage text := btrim(coalesce(p_stage, '')); v_set jsonb;
begin
  if not coalesce(public.crm_stages(p_org) @> to_jsonb(v_stage), false) then raise exception 'Choose a stage from the pipeline.' using errcode = '22023'; end if;
  if v_lead.stage = v_stage then return; end if;
  v_set := coalesce(public.workspace_live_definition(p_org) #> array['pipeline','stageSettings', v_stage], '{}'::jsonb);
  if coalesce((v_set->>'requires_assignee')::boolean, false) and v_lead.assigned_to is null then
    raise exception 'A lead needs an assignee before it can move to "%".', v_stage using errcode = '22023'; end if;
  if coalesce((v_set->>'requires_summary')::boolean, false) and coalesce(btrim(v_lead.summary), '') = '' then
    raise exception 'A lead needs a summary before it can move to "%".', v_stage using errcode = '22023'; end if;
  update public.leads set stage = v_stage where id = p_lead;
  perform public.crm_log(p_org, p_lead, 'stage_changed', null, jsonb_build_object('from', v_lead.stage, 'to', v_stage));
  perform public.crm_emit(p_org, 'lead.stage_changed', 'lead', p_lead, jsonb_build_object('from', v_lead.stage, 'to', v_stage));
end $$;

-- ---------- workspace configuration drafts: optimistic concurrency for the visual editors ----------
create or replace function public.workspace_draft_token(p_org uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if public.crm_member_role(p_org) not in ('owner','admin') then raise exception 'Only owners and admins can edit the workspace configuration.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'token', coalesce((select md5(definition::text) from public.workspace_configuration_versions where organization_id = p_org and status = 'draft'), 'none'),
    'published', (select max(revision) from public.workspace_configuration_versions where organization_id = p_org and status = 'published'));
end $$;
-- Same validation and storage as save_workspace_draft; refused when the draft or the live version changed since the editor loaded.
create or replace function public.save_workspace_visual(p_org uuid, p_definition jsonb, p_expected_token text, p_expected_published integer) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_cur jsonb; v_rev integer;
begin
  if public.crm_member_role(p_org) not in ('owner','admin') then raise exception 'Only owners and admins can edit the workspace configuration.' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('ws:' || p_org::text));
  v_cur := public.workspace_draft_token(p_org);
  if p_expected_token is distinct from v_cur->>'token' or p_expected_published is distinct from (v_cur->>'published')::integer then
    raise exception 'The workspace configuration changed since you opened it (it was saved or published elsewhere). Reload to see the latest version; your edits were not saved.' using errcode = '22023'; end if;
  v_rev := public.save_workspace_draft(p_org, p_definition);
  return jsonb_build_object('revision', v_rev) || public.workspace_draft_token(p_org);
end $$;
revoke all on function public.workspace_draft_token(uuid), public.save_workspace_visual(uuid, jsonb, text, integer) from public, anon;
grant execute on function public.workspace_draft_token(uuid), public.save_workspace_visual(uuid, jsonb, text, integer) to authenticated;

-- ---------- contact privacy: phone and email are no longer readable straight from the table ----------
-- Before: any signed-in member could `select phone, email from contacts` for every contact RLS let them see, whatever their role allowed.
-- Now: column-level SELECT on contacts.phone / contacts.email is revoked from clients. The only client read path is contact_phone() / contact_email(), which return the value only when
--   (1) the caller's role may view contact details (module "contacts", action "view"; every base role keeps it unless a custom role turns it off), and
--   (2) the caller can see the contact: an owner/admin, or someone who can see at least one of the contact's leads (same rules as the leads policies, scope included).
-- Server-side (definer) functions, workers and the service role are unaffected.
create or replace function public.role_validate(p_base text, p_perms jsonb, p_scopes jsonb) returns void language plpgsql immutable set search_path = '' as $$
declare m text; a text; v jsonb;
begin
  if p_base not in ('admin','manager','employee') then raise exception 'A role is based on admin, manager or employee.' using errcode = '22023'; end if;
  if jsonb_typeof(p_perms) is distinct from 'object' or jsonb_typeof(p_scopes) is distinct from 'object' then raise exception 'Invalid role permissions.' using errcode = '22023'; end if;
  for m, v in select key, value from jsonb_each(p_perms) loop
    if m !~ '^(leads|contacts|tasks|appointments|inventory|billing|dashboards|reports|integrations|automations|team|custom:[a-z0-9]+(-[a-z0-9]+)*)$' or jsonb_typeof(v) is distinct from 'object' then raise exception 'Unknown module "%" in role permissions.', m using errcode = '22023'; end if;
    for a, v in select key, value from jsonb_each(p_perms->m) loop
      if a not in ('view','create','edit','archive','export','assign','approve') or jsonb_typeof(v) is distinct from 'boolean' or (m = 'contacts' and a <> 'view') then raise exception 'Invalid permission "%.%".', m, a using errcode = '22023'; end if;
      if v::text::boolean and not public.perm_default(p_base, m, a) then raise exception 'A role based on % cannot be granted "%" in "%": custom roles can only narrow their base role.', p_base, a, m using errcode = '22023'; end if;
    end loop;
  end loop;
  for m, v in select key, value from jsonb_each(p_scopes) loop
    if m !~ '^(leads|tasks|appointments|billing|custom:[a-z0-9]+(-[a-z0-9]+)*)$' or jsonb_typeof(v) is distinct from 'string' or (v #>> '{}') not in ('all','team','assigned','own') then raise exception 'Invalid visibility for "%".', m using errcode = '22023'; end if;
  end loop;
end $$;

-- the single definition of "may the caller see this contact's details"
create or replace function public.contact_details_visible(p_contact uuid) returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid;
begin
  if (select auth.uid()) is null then return false; end if;
  select organization_id into v_org from public.contacts where id = p_contact;
  if v_org is null or public.org_role(v_org) is null then return false; end if;
  if not public.perm_ok(v_org, 'contacts', 'view') or not public.perm_ok(v_org, 'leads', 'view') then return false; end if;
  if public.org_role(v_org) in ('owner','admin') then return true; end if;
  return exists (select 1 from public.leads l where l.contact_id = p_contact and l.organization_id = v_org and public.can_see_lead(l.organization_id, l.assigned_to) and public.perm_scope_ok(l.organization_id, 'leads', l.assigned_to, l.created_by));
end $$;
create or replace function public.contact_phone(p_contact uuid) returns text language sql stable security definer set search_path = '' as $$
  select c.phone from public.contacts c where c.id = p_contact and public.contact_details_visible(p_contact);
$$;
create or replace function public.contact_email(p_contact uuid) returns text language sql stable security definer set search_path = '' as $$
  select c.email from public.contacts c where c.id = p_contact and public.contact_details_visible(p_contact);
$$;
revoke all on function public.contact_details_visible(uuid), public.contact_phone(uuid), public.contact_email(uuid) from public, anon;
grant execute on function public.contact_details_visible(uuid), public.contact_phone(uuid), public.contact_email(uuid) to authenticated;

revoke select on public.contacts from authenticated;
grant select (id, organization_id, full_name, created_by, created_at, updated_at) on public.contacts to authenticated;

-- the lead read model keeps its columns (phone / email now come from the checked functions) and says when details are hidden from the caller
drop view public.crm_lead_list;
create view public.crm_lead_list with (security_invoker = true) as
  select l.id, l.organization_id, l.stage, l.source, l.summary, l.assigned_to, l.created_at, l.updated_at,
         c.id as contact_id, c.full_name, public.contact_phone(c.id) as phone, public.contact_email(c.id) as email,
         (select count(*) from public.tasks t where t.lead_id = l.id and t.status = 'open')::int as open_tasks,
         not public.contact_details_visible(c.id) as contact_hidden
  from public.leads l join public.contacts c on c.id = l.contact_id and c.organization_id = l.organization_id;
revoke all on public.crm_lead_list from anon, authenticated; grant select on public.crm_lead_list to authenticated;

-- AI lead lookup (0009): same output shape, but contact details come only from the checked functions
create or replace function public.ai_tool_get_lead(p_org uuid, p_lead uuid, p_include_contact boolean) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_role text := public.ai_ctx(p_org); l public.leads; v_name text; v_phone text; v_email text; v_keep boolean := coalesce(p_include_contact, false); v_acts jsonb; v_tasks jsonb; v_attr jsonb; v_shown boolean;
begin
  select * into l from public.leads where id = p_lead and organization_id = p_org;
  if not found then raise exception 'Lead not found, or you cannot see it.' using errcode = 'P0002'; end if;
  select full_name into v_name from public.contacts where id = l.contact_id and organization_id = p_org;
  v_phone := public.contact_phone(l.contact_id); v_email := public.contact_email(l.contact_id);
  v_shown := public.contact_details_visible(l.contact_id); v_keep := v_keep and v_shown;
  select coalesce(jsonb_agg(jsonb_build_object('kind', a.kind, 'note', public.ai_text(a.body, 300, v_keep), 'at', a.created_at) order by a.created_at desc, a.seq desc), '[]'::jsonb) into v_acts
    from (select * from public.lead_activities where lead_id = p_lead and organization_id = p_org order by created_at desc, seq desc limit 10) a;
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'title', public.ai_text(t.title, 120, v_keep), 'owner', public.ai_email(p_org, t.owner_id), 'due_date', t.due_date, 'status', t.status, 'outcome', public.ai_text(t.outcome, 200, v_keep)) order by t.due_date, t.id), '[]'::jsonb) into v_tasks
    from (select * from public.tasks where lead_id = p_lead and organization_id = p_org order by status, due_date, id limit 10) t;
  select jsonb_build_object('provider', provider, 'utm', utm) into v_attr from public.lead_attribution where lead_id = p_lead;
  return jsonb_build_object('id', l.id, 'name', v_name, 'stage', l.stage, 'source', l.source, 'assigned_to', public.ai_email(p_org, l.assigned_to), 'created_at', l.created_at, 'updated_at', l.updated_at,
    'summary', public.ai_text(l.summary, 500, v_keep), 'contact_details_included', v_keep and v_role is not null, 'contact_details_hidden_by_role', not v_shown,
    'phone', case when not v_shown then null when v_keep then v_phone else public.ai_mask_phone(v_phone) end, 'email', case when not v_shown then null when v_keep then v_email else public.ai_mask_email(v_email) end,
    'activities', v_acts, 'tasks', v_tasks, 'attribution', v_attr);
end $$;

-- Editing a lead as someone whose role hides contact details must not erase them (the edit form cannot show them, so it cannot resubmit them).
create or replace function public.crm_update_lead(p_org uuid, p_lead uuid, p_full_name text, p_phone text, p_email text, p_source text, p_summary text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_role text := public.crm_member_role(p_org); v_lead public.leads := public.crm_lock_lead(p_org, p_lead, public.crm_member_role(p_org));
  v_c public.contacts; v_name text := public.crm_norm_name(p_full_name); v_phone text := public.crm_norm_phone(p_phone); v_email text := public.crm_norm_email(p_email);
  v_source text := public.crm_norm_source(p_source); v_summary text := public.crm_norm_text(p_summary, 2000, 'Summary'); v_changed text[] := '{}';
begin
  select * into v_c from public.contacts where id = v_lead.contact_id;
  -- a caller who may not see contact details cannot overwrite or clear them either: the stored values are kept
  if not public.contact_details_visible(v_c.id) then v_phone := v_c.phone; v_email := v_c.email; end if;
  if v_c.full_name is distinct from v_name then v_changed := array_append(v_changed, 'name'); end if;
  if v_c.phone is distinct from v_phone then v_changed := array_append(v_changed, 'phone'); end if;
  if v_c.email is distinct from v_email then v_changed := array_append(v_changed, 'email'); end if;
  if v_lead.source is distinct from v_source then v_changed := array_append(v_changed, 'source'); end if;
  if v_lead.summary is distinct from v_summary then v_changed := array_append(v_changed, 'summary'); end if;
  if cardinality(v_changed) = 0 then return; end if;
  update public.contacts set full_name = v_name, phone = v_phone, email = v_email, updated_at = now() where id = v_c.id;
  update public.leads set source = v_source, summary = v_summary where id = p_lead;
  perform public.crm_log(p_org, p_lead, 'updated', null, jsonb_build_object('fields', to_jsonb(v_changed)));
  perform public.crm_emit(p_org, 'lead.updated', 'lead', p_lead, jsonb_build_object('fields', to_jsonb(v_changed)));
exception when unique_violation then
  raise exception 'Another contact already uses that phone number or email.' using errcode = '23505';
end $$;
