-- ---------------------------------------------------------------------------
-- 0007_audit_email_attribution.sql — Phase 2 polish
--
-- The catalog audit trigger (from 0004) records user_id via auth.uid() but
-- leaves user_email null, so audit rows written through the app's
-- session-authenticated write path were missing the actor's email even when
-- the user was known. This recreates public.audit_catalog_change() with the
-- same behaviour plus user_email resolution from public.profiles — exactly
-- like the Phase 2 stock engine RPCs already do.
--
-- Safe to run at any time: idempotent (drop + recreate), no data changes,
-- only affects FUTURE audit rows.
-- ---------------------------------------------------------------------------

begin;

create or replace function public.audit_catalog_change()
returns trigger
language plpgsql
security definer set search_path = public as $$
declare
  v_action public.audit_action;
  v_entity text := tg_table_name;
  v_price_keys text[] := array['cost_price','mrp','selling_price','wholesale_price','gst_rate'];
  v_key text;
  v_user uuid := auth.uid();
  v_email text := (select p.email from public.profiles p where p.id = auth.uid());
begin
  if tg_op = 'DELETE' then
    v_action := case when tg_table_name in ('products','product_variants') then 'product_deleted' else 'settings_changed' end;
    insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, old_values)
    values (v_user, v_email, v_action, v_entity, old.id::text,
            to_jsonb(old) - 'created_at' - 'updated_at');
    return old;
  end if;

  if tg_op = 'UPDATE'
     and (to_jsonb(old) - 'updated_at') is not distinct from (to_jsonb(new) - 'updated_at') then
    return new; -- nothing meaningful changed
  end if;

  v_action := case
    when tg_table_name in ('products','product_variants') then
      case when tg_op = 'INSERT' then 'product_created' else 'product_updated' end
    else 'settings_changed'
  end;

  insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, new_values)
  values (v_user, v_email, v_action, v_entity, new.id::text,
          to_jsonb(new) - 'created_at' - 'updated_at');

  -- price changes get their own audit row (products AND variants)
  if tg_op = 'UPDATE' and tg_table_name in ('products','product_variants') then
    foreach v_key in array v_price_keys loop
      if to_jsonb(old) ->> v_key is distinct from to_jsonb(new) ->> v_key then
        insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id,
                                        old_values, new_values, metadata)
        values (v_user, v_email, 'price_changed', v_entity, new.id::text,
                jsonb_build_object(v_key, to_jsonb(old) -> v_key),
                jsonb_build_object(v_key, to_jsonb(new) -> v_key),
                jsonb_build_object('sku', to_jsonb(new) -> 'sku',
                                   'product_id', to_jsonb(new) -> 'product_id'));
      end if;
    end loop;
  end if;

  return coalesce(new, old);
end $$;

-- sanity echo for the SQL editor output
select '0007 audit email attribution applied' as status,
       obj_description('public.audit_catalog_change()'::regprocedure, 'pg_catalog') is not null as function_exists;

commit;
