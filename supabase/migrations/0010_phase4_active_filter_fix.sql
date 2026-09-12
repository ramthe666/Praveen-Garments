-- ---------------------------------------------------------------------------
-- 0010_phase4_active_filter_fix.sql
--
-- WHAT: Recreates customers_page() and suppliers_page() with an explicit
--       array_append() for the active/inactive filter predicates.
--
-- WHY: Migration 0009 built the dynamic WHERE array with
--         v_where := v_where || 'sp.is_active';   -- text[] || 'literal'
--       When the right operand is an *unknown-type* string literal, some
--       PostgreSQL versions resolve the || operator as text || text (after
--       coercing the array to its text representation) instead of the
--       intended anyarray || anyelement append. The PL/pgSQL assignment
--       then tries to cast the concatenated TEXT back to text[] and fails
--       with 22P02 "malformed array literal". The same expression with a
--       typed text right-hand side (e.g. format(...) output) resolves
--       correctly, which is why search/type filters worked while the
--       active/inactive filters 400'd.
--
-- FIX: v_where := array_append(v_where, 'sp.is_active');  — an explicit
--       function call has no operator-resolution ambiguity and behaves
--       identically on every PostgreSQL version.
--
-- SCOPE: function bodies only, same signatures, same grants. No table or
--       data changes. Additive and idempotent, like every migration here.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- customers_page (fixed)
-- ---------------------------------------------------------------------------
create or replace function public.customers_page(
  p_search     text default null,
  p_type       text default null,
  p_active     text default null,
  p_limit      int  default 25,
  p_offset     int  default 0
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_where    text[] := array['true'];
  v_filtered boolean := false;
  v_sql      text;
  v_rows     jsonb;
  v_total    bigint;
  v_estimate bigint;
begin
  if auth.uid() is not null
     and not (public.has_app_permission('manage_customers')
              or public.has_app_permission('record_customer_payment')
              or public.has_app_permission('view_sales')) then
    raise exception 'You do not have permission to view customers.';
  end if;

  p_limit  := least(greatest(coalesce(p_limit, 25), 1), 100);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  if nullif(trim(coalesce(p_search, '')), '') is not null then
    v_filtered := true;
    v_where := v_where || format(
      '(c.name ILIKE %1$L OR c.phone ILIKE %1$L OR c.email ILIKE %1$L OR c.gstin ILIKE %1$L)',
      '%' || trim(p_search) || '%');
  end if;
  if p_type in ('retail','wholesale') then
    v_filtered := true;
    v_where := v_where || format('c.customer_type = %L', p_type);
  end if;
  if p_active = 'active' then
    v_filtered := true;
    v_where := array_append(v_where, 'c.is_active');
  elsif p_active = 'inactive' then
    v_filtered := true;
    v_where := array_append(v_where, 'not c.is_active');
  end if;

  v_sql := format($sql$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select c.id, c.name, c.phone, c.alt_phone, c.email, c.city, c.state,
             c.gstin, c.customer_type, c.credit_limit, c.notes, c.is_active,
             c.created_at,
             coalesce(st.total_billed, 0)  as total_billed,
             coalesce(st.bills, 0)         as bills,
             coalesce(st.outstanding, 0)   as outstanding,
             coalesce(pay.paid_total, 0)   as total_paid,
             coalesce(pay.advance, 0)      as advance
      from public.customers c
      left join lateral (
        select sum(s.grand_total) as total_billed,
               count(*) as bills,
               sum(s.due_amount) as outstanding
        from public.sales s
        where s.customer_id = c.id and s.status = 'COMPLETED'
      ) st on true
      left join lateral (
        select sum(cp.amount) as paid_total,
               sum(cp.amount - cp.allocated_amount) as advance
        from public.customer_payments cp
        where cp.customer_id = c.id
      ) pay on true
      where %s
      order by (coalesce(st.outstanding, 0) > 0) desc, c.name asc, c.id
      limit %s offset %s
    ) t
  $sql$, array_to_string(v_where, ' and '), p_limit, p_offset);

  execute v_sql into v_rows;

  if v_filtered then
    execute format('select count(*) from public.customers c where %s',
                   array_to_string(v_where, ' and ')) into v_total;
  else
    select greatest(round(reltuples::numeric), 0)::bigint into v_estimate
    from pg_class where relname = 'customers' and relnamespace = 'public'::regnamespace;
    if coalesce(v_estimate, 0) > 0 then
      v_total := v_estimate;
    else
      execute 'select count(*) from public.customers' into v_total;
    end if;
  end if;

  return jsonb_build_object('rows', v_rows, 'total', v_total, 'total_is_estimate', not v_filtered);
end $$;

revoke all on function public.customers_page(text, text, text, int, int) from public, anon;
grant execute on function public.customers_page(text, text, text, int, int) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- suppliers_page (fixed)
-- ---------------------------------------------------------------------------
create or replace function public.suppliers_page(
  p_search  text default null,
  p_active  text default null,
  p_limit   int  default 25,
  p_offset  int  default 0
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_where    text[] := array['true'];
  v_filtered boolean := false;
  v_sql      text;
  v_rows     jsonb;
  v_total    bigint;
  v_estimate bigint;
begin
  if auth.uid() is not null
     and not (public.has_app_permission('manage_suppliers')
              or public.has_app_permission('view_purchases')
              or public.has_app_permission('record_supplier_payment')) then
    raise exception 'You do not have permission to view suppliers.';
  end if;

  p_limit  := least(greatest(coalesce(p_limit, 25), 1), 100);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  if nullif(trim(coalesce(p_search, '')), '') is not null then
    v_filtered := true;
    v_where := v_where || format(
      '(sp.name ILIKE %1$L OR sp.phone ILIKE %1$L OR sp.contact_person ILIKE %1$L OR sp.gstin ILIKE %1$L)',
      '%' || trim(p_search) || '%');
  end if;
  if p_active = 'active' then
    v_filtered := true;
    v_where := array_append(v_where, 'sp.is_active');
  elsif p_active = 'inactive' then
    v_filtered := true;
    v_where := array_append(v_where, 'not sp.is_active');
  end if;

  v_sql := format($sql$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select sp.id, sp.name, sp.contact_person, sp.phone, sp.email, sp.city,
             sp.state, sp.gstin, sp.notes, sp.is_active, sp.created_at,
             coalesce(st.total_purchases, 0) as total_purchases,
             coalesce(st.invoices, 0)         as invoices,
             coalesce(st.payable, 0)          as outstanding,
             coalesce(pay.paid_total, 0)      as total_paid
      from public.suppliers sp
      left join lateral (
        select sum(pi.grand_total) as total_purchases,
               count(*) as invoices,
               sum(pi.due_amount) as payable
        from public.purchase_invoices pi
        where pi.supplier_id = sp.id and pi.status = 'RECEIVED'
      ) st on true
      left join lateral (
        select sum(spp.amount) as paid_total
        from public.supplier_payments spp
        where spp.supplier_id = sp.id
      ) pay on true
      where %s
      order by (coalesce(st.payable, 0) > 0) desc, sp.name asc, sp.id
      limit %s offset %s
    ) t
  $sql$, array_to_string(v_where, ' and '), p_limit, p_offset);

  execute v_sql into v_rows;

  if v_filtered then
    execute format('select count(*) from public.suppliers sp where %s',
                   array_to_string(v_where, ' and ')) into v_total;
  else
    select greatest(round(reltuples::numeric), 0)::bigint into v_estimate
    from pg_class where relname = 'suppliers' and relnamespace = 'public'::regnamespace;
    if coalesce(v_estimate, 0) > 0 then
      v_total := v_estimate;
    else
      execute 'select count(*) from public.suppliers' into v_total;
    end if;
  end if;

  return jsonb_build_object('rows', v_rows, 'total', v_total, 'total_is_estimate', not v_filtered);
end $$;

revoke all on function public.suppliers_page(text, text, int, int) from public, anon;
grant execute on function public.suppliers_page(text, text, int, int) to authenticated, service_role;

commit;
