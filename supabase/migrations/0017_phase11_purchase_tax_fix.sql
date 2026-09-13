-- =============================================================================
-- 0017_phase11_purchase_tax_fix.sql
--
-- Fix (run after 0016): Phase 9 P9-BUG-2 — purchase invoice tax double-count.
--
-- WHAT WAS WRONG
--   create_purchase_invoice (0009) accumulated v_subtotal from the LINE
--   totals (tax-inclusive amounts in both tax modes) and then computed
--   grand_total = subtotal - discount_total + tax_total, i.e. it ADDED the
--   tax on top of a subtotal that already contained it and subtracted the
--   line discounts a second time. Both modes were wrong:
--     * inclusive, 10 x 600 @ 12% GST: stored grand 6642.86
--       (correct: 6000 — the entered costs already contain the tax)
--     * exclusive, 10 x 600 @ 12% GST: stored grand 7440.00
--       (correct: 6720 — 6000 + 720 tax, matching the purchase order)
--   The purchase ORDER for the same items showed 6720, and purchase returns
--   credited proportionally to the line (mode-correct), so the invoice
--   payable was the inconsistent figure: supplier payables (due_amount =
--   grand_total) were overstated by roughly one tax amount per invoice.
--   The app UI also never sends tax_mode, and the RPC silently fell back to
--   the POS *sales* setting (default_tax_mode = 'inclusive') — a customer-
--   price convention leaking into a supplier cost document.
--
-- THE FIX (function replacement — same signature, same permission gate,
--   same audit shape; item-line math is untouched because it was always
--   correct in both modes):
--   1. grand_total = Σ line_total in BOTH modes (sales-engine invariant).
--      inclusive: grand = Σ(gross - line disc)      — costs contain GST
--      exclusive: grand = Σ(gross - line disc + GST) — GST added on top
--      => grand always equals what purchase-return credits and FIFO
--         payments are computed against.
--   2. subtotal = Σ gross (pre-discount cost base) — the same convention as
--      purchase orders, so a PO and its PI now agree for the same items.
--   3. Purchases default to tax_mode 'exclusive' (cost + GST added on top),
--      matching the purchase UIs ("tax added by the server") and PO math.
--      The POS default_tax_mode no longer leaks into supplier bills. An
--      explicit payload tax_mode is still honoured.
--
-- DATA REPAIR (idempotent — recomputes from item rows, which are and always
--   were mode-correct):
--   * every non-CANCELLED purchase invoice gets its document totals
--     recomputed from its items: subtotal = Σ(qty x unit_cost),
--     discount_total = Σ(line discounts), tax_total = Σ(item tax),
--     grand_total = Σ(line_total).
--   * RECEIVED invoices additionally get due_amount = grand - paid - return
--     credits (floor 0) and payment_status per the engine convention
--     (PAID / PARTIALLY_PAID / DUE). paid_amount is NOT rewritten — those
--     are real recorded payments.
--   * CANCELLED invoices are left untouched (excluded from payables and
--     reports by status filters).
--   * Note for fully-paid historical invoices: if a payment was recorded at
--     the old inflated total, paid_amount can now exceed grand_total. The
--     difference is the historical tax over-charge recorded before this
--     fix; due_amount is floored at 0 and the invoice shows PAID. The
--     purchase reports (which sum grand_total) become correct from the
--     moment this migration is applied.
--
-- No tables, columns, constraints, RLS policies or signatures change.
-- Grants are re-issued verbatim. Additive and idempotent.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- PART 1 — create_purchase_invoice with corrected totals math.
--   Verbatim body from 0009 with six surgical edits (E1..E6) marked with
--   "0017:" comments. Item validation, PO linking, numbering, stock,
--   payable and audit flows are byte-identical.
-- ---------------------------------------------------------------------------
create or replace function public.create_purchase_invoice(p_payload jsonb)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user     uuid := auth.uid();
  v_email    text;
  v_name     text;
  v_supplier public.suppliers%rowtype;
  v_company  public.company_settings%rowtype;
  v_location record;
  v_po       public.purchase_orders%rowtype;
  v_status   text := upper(coalesce(nullif(p_payload ->> 'status', ''), 'DRAFT'));
  v_invoice_number text;
  v_invoice_id uuid;
  v_items    jsonb := '[]'::jsonb;
  v_item     jsonb;
  v_seen     uuid[] := array[]::uuid[];
  v_vid      uuid;
  v_sku      text; v_pname text; v_size text; v_color text;
  v_qty      int; v_cost numeric; v_disc numeric;
  v_gst      numeric; v_taxamt numeric; v_gross numeric; v_line numeric;
  v_subtotal numeric := 0; v_disc_total numeric := 0; v_tax_total numeric := 0;
  v_grand    numeric := 0;
  v_tax_enabled boolean; v_default_rate numeric;
  v_tax_mode text; v_inter_state boolean := false;
  v_po_item_id uuid;
  v_po_remaining int;
  v_result    jsonb;
begin
  perform public.require_permission('manage_purchases', 'You do not have permission to manage purchases.');

  if v_status not in ('DRAFT','RECEIVED') then
    raise exception 'Status must be DRAFT or RECEIVED.';
  end if;

  select email, coalesce(nullif(trim(full_name), ''), '') into v_email, v_name
    from public.profiles where id = v_user and is_active;
  if v_email is null then
    raise exception 'Your account is not active.';
  end if;

  select * into v_supplier from public.suppliers
    where id = nullif(p_payload ->> 'supplier_id', '')::uuid and is_active;
  if v_supplier.id is null then
    raise exception 'SUPPLIER_NOT_FOUND: supplier not found or inactive.';
  end if;

  select id, name into v_location from public.stock_locations
    where id = nullif(p_payload ->> 'location_id', '')::uuid and is_active;
  if v_location.id is null then
    raise exception 'Stock location not found or inactive.';
  end if;

  -- optional linked PO (must be ORDERED-ish; DRAFT POs must be ordered first)
  if nullif(p_payload ->> 'po_id', '') is not null then
    select * into v_po from public.purchase_orders
      where id = (p_payload ->> 'po_id')::uuid for update;
    if v_po.id is null then
      raise exception 'Purchase order not found.';
    end if;
    if v_po.status not in ('ORDERED','PARTIALLY_RECEIVED','RECEIVED') then
      raise exception 'PO_NOT_ORDERED: the purchase order must be in ORDERED state before goods can be received.';
    end if;
    if v_po.supplier_id <> v_supplier.id then
      raise exception 'The purchase order belongs to a different supplier.';
    end if;
  end if;

  select * into v_company from public.company_settings limit 1;
  if v_company.state is not null and v_supplier.state is not null
     and lower(trim(v_supplier.state)) <> lower(trim(v_company.state)) then
    v_inter_state := true;
  end if;

  v_tax_enabled := coalesce((public.setting_of('tax', 'enabled', 'true'::jsonb))::boolean, true);
  v_default_rate := coalesce((public.setting_of('tax', 'default_rate', '5'::jsonb))::numeric, 5);
  -- 0017: a purchase invoice is a COST-side document — the entered unit cost
  -- is the pre-tax cost and GST is added on top, exactly like purchase orders
  -- and the app's purchase UIs ("tax added by the server"). The POS
  -- default_tax_mode is a SALES price setting (MRP-style) and must never leak
  -- into supplier bills. An explicit payload tax_mode is still honoured
  -- ('inclusive' = the entered costs already contain the GST).
  v_tax_mode := coalesce(nullif(p_payload ->> 'tax_mode', ''), 'exclusive');

  if jsonb_typeof(p_payload -> 'items') <> 'array'
     or (select count(*) from jsonb_array_elements(p_payload -> 'items')) = 0 then
    raise exception 'Add at least one item to the purchase invoice.';
  end if;

  -- duplicate supplier invoice number (friendly pre-check; the partial
  -- unique index is the hard guarantee under concurrency)
  if nullif(trim(coalesce(p_payload ->> 'supplier_invoice_no', '')), '') is not null then
    if exists (
      select 1 from public.purchase_invoices
      where supplier_id = v_supplier.id
        and supplier_invoice_no = trim(p_payload ->> 'supplier_invoice_no')
        and status <> 'CANCELLED'
    ) then
      raise exception 'DUPLICATE_SUPPLIER_INVOICE: invoice number "%" already exists for this supplier.', trim(p_payload ->> 'supplier_invoice_no');
    end if;
  end if;

  for v_item in select * from jsonb_array_elements(p_payload -> 'items') loop
    v_vid := nullif(v_item ->> 'variant_id', '')::uuid;
    if v_vid is null then
      raise exception 'Invalid item: missing variant.';
    end if;
    if v_vid = any(v_seen) then
      raise exception 'Duplicate item line for one variant — increase the quantity instead.';
    end if;
    v_seen := v_seen || v_vid;

    if coalesce(v_item ->> 'quantity', '') !~ '^[0-9]{1,6}$' or (v_item ->> 'quantity')::int <= 0 then
      raise exception 'Invalid quantity for one of the items.';
    end if;
    v_qty := (v_item ->> 'quantity')::int;

    if coalesce(v_item ->> 'unit_cost', '') !~ '^[0-9]+(\.[0-9]{1,2})?$' then
      raise exception 'Invalid cost for one of the items.';
    end if;
    v_cost := (v_item ->> 'unit_cost')::numeric;

    v_disc := coalesce(nullif(v_item ->> 'discount_amount', '')::numeric, 0);
    if v_disc < 0 or v_disc > round(v_cost * v_qty, 2) then
      raise exception 'Invalid discount for one of the items.';
    end if;

    select pv.sku, p.name, s.name, c.name into v_sku, v_pname, v_size, v_color
      from public.product_variants pv
      join public.products p on p.id = pv.product_id
      left join public.sizes s on s.id = pv.size_id
      left join public.colors c on c.id = pv.color_id
      where pv.id = v_vid;
    if v_sku is null then
      raise exception 'VARIANT_NOT_FOUND: one of the items no longer exists.';
    end if;

    -- PO link: never receive more than the remaining ordered quantity
    v_po_item_id := nullif(v_item ->> 'po_item_id', '')::uuid;
    if v_po_item_id is not null then
      if v_po.id is null or v_po_item_id is null then
        raise exception 'Item references a PO line but no purchase order is linked.';
      end if;
      select (poi.quantity - poi.received_quantity) into v_po_remaining
        from public.purchase_order_items poi
        where poi.id = v_po_item_id and poi.po_id = v_po.id
        for update;
      if v_po_remaining is null then
        raise exception 'The referenced purchase order line does not belong to this PO.';
      end if;
      if v_qty > v_po_remaining then
        raise exception 'RECEIVE_EXCEEDS_ORDERED: only % left to receive for % (%).', v_po_remaining, v_pname, v_sku;
      end if;
    end if;

    v_gst := case when v_tax_enabled then
      coalesce((select p2.gst_rate from public.products p2
                join public.product_variants pv2 on pv2.product_id = p2.id where pv2.id = v_vid), v_default_rate)
      else 0 end;

    v_gross := round(v_cost * v_qty, 2);
    if v_tax_mode = 'inclusive' then
      v_taxamt := round((v_gross - v_disc) * v_gst / (100 + v_gst), 2);
      v_line := round(v_gross - v_disc, 2);
    else
      v_taxamt := round((v_gross - v_disc) * v_gst / 100, 2);
      v_line := round(v_gross - v_disc + v_taxamt, 2);
    end if;

    -- 0017: subtotal is the pre-discount cost base (Σ gross) — the same
    -- convention as purchase orders — NOT the tax-inclusive line total.
    -- v_grand accumulates the line totals, which are mode-correct by
    -- construction (inclusive: tax inside the line; exclusive: tax on top),
    -- so grand_total = Σ line_total in BOTH modes. This is the exact value
    -- purchase-return credits and FIFO payments are computed against.
    v_subtotal := round(v_subtotal + v_gross, 2);
    v_grand    := round(v_grand + v_line, 2);
    v_disc_total := round(v_disc_total + v_disc, 2);
    v_tax_total := round(v_tax_total + v_taxamt, 2);

    v_items := v_items || jsonb_build_object(
      'line_no', jsonb_array_length(v_items) + 1,
      'po_item_id', v_po_item_id, 'variant_id', v_vid,
      'product_name', v_pname, 'sku', v_sku, 'size_name', v_size, 'color_name', v_color,
      'quantity', v_qty, 'unit_cost', v_cost, 'discount_amount', v_disc,
      'gst_rate', v_gst, 'tax_amount', v_taxamt, 'line_total', v_line
    );
  end loop;

  v_invoice_number := public.next_doc_number(public.doc_prefix('purchase_invoice_prefix', 'PI'));

  insert into public.purchase_invoices (
    invoice_number, supplier_id, supplier_name, po_id, po_number,
    supplier_invoice_no, supplier_invoice_date, location_id, location_name,
    invoice_date, status, subtotal, discount_total, tax_total, grand_total,
    paid_amount, due_amount, payment_status, tax_mode, inter_state, notes,
    created_by
  ) values (
    v_invoice_number, v_supplier.id, v_supplier.name, v_po.id, v_po.po_number,
    nullif(trim(coalesce(p_payload ->> 'supplier_invoice_no', '')), ''),
    nullif(p_payload ->> 'supplier_invoice_date', '')::date,
    v_location.id, v_location.name,
    coalesce(nullif(p_payload ->> 'invoice_date', '')::timestamptz, now()),
    -- always created DRAFT: receiving (stock + payable side effects) is the
    -- only path to RECEIVED, whether inline (status=RECEIVED) or via confirm.
    'DRAFT', v_subtotal, v_disc_total, v_tax_total,
    v_grand,
    0, 0, 'DUE',
    v_tax_mode, v_inter_state, nullif(trim(coalesce(p_payload ->> 'notes', '')), ''),
    v_user
  )
  returning id into v_invoice_id;

  for v_item in select * from jsonb_array_elements(v_items) loop
    insert into public.purchase_invoice_items (
      invoice_id, line_no, po_item_id, variant_id, product_name, sku, size_name, color_name,
      quantity, unit_cost, discount_amount, gst_rate, tax_amount, line_total
    ) values (
      v_invoice_id, coalesce((v_item ->> 'line_no')::int, 0),
      nullif(v_item ->> 'po_item_id', '')::uuid,
      (v_item ->> 'variant_id')::uuid, v_item ->> 'product_name',
      v_item ->> 'sku', v_item ->> 'size_name', v_item ->> 'color_name',
      (v_item ->> 'quantity')::int, (v_item ->> 'unit_cost')::numeric,
      (v_item ->> 'discount_amount')::numeric, (v_item ->> 'gst_rate')::numeric,
      (v_item ->> 'tax_amount')::numeric, (v_item ->> 'line_total')::numeric
    );
  end loop;

  if v_status = 'RECEIVED' then
    v_result := public.do_receive_purchase_invoice(v_invoice_id, v_user, v_email);
  else
    v_result := jsonb_build_object('received', false);
  end if;

  insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
  values (v_user, v_email,
          case when v_status = 'RECEIVED' then 'purchase_received' else 'purchase_created' end::public.audit_action,
          'purchase_invoice', v_invoice_id::text,
          jsonb_build_object(
            'invoice_number', v_invoice_number,
            'supplier', v_supplier.name,
            'po_number', v_po.po_number,
            'supplier_invoice_no', p_payload ->> 'supplier_invoice_no',
            'location', v_location.name,
            'items', jsonb_array_length(v_items),
            'grand_total', v_grand,
            'status', v_status
          ));

  return jsonb_build_object(
    'invoice_id', v_invoice_id,
    'invoice_number', v_invoice_number,
    'status', v_status,
    'grand_total', v_grand,
    'due_amount', v_grand,
    'result', v_result
  );
end $$;

revoke all on function public.create_purchase_invoice(jsonb) from public, anon;
grant execute on function public.create_purchase_invoice(jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- PART 2 — data repair: recompute document totals of existing invoices from
-- their item rows (mode-correct by construction). Pure recompute — running
-- it twice produces the same numbers (idempotent).
-- ---------------------------------------------------------------------------

-- 2a. every non-cancelled invoice: the four money columns.
with re as (
  select pi.id,
         round(coalesce(sum(pii.quantity * pii.unit_cost), 0), 2) as sub,
         round(coalesce(sum(pii.discount_amount), 0), 2)          as disc,
         round(coalesce(sum(pii.tax_amount), 0), 2)               as tax,
         round(coalesce(sum(pii.line_total), 0), 2)               as grand
    from public.purchase_invoices pi
    join public.purchase_invoice_items pii on pii.invoice_id = pi.id
   where pi.status in ('DRAFT', 'RECEIVED')
   group by pi.id
)
update public.purchase_invoices pi
   set subtotal       = re.sub,
       discount_total = re.disc,
       tax_total      = re.tax,
       grand_total    = re.grand
  from re
 where pi.id = re.id;

-- 2b. RECEIVED invoices: payable + payment status from the repaired grand.
--     paid_amount is untouched (real payments); return credits (applied_to_due)
--     are honoured, exactly like the engine's own arithmetic.
update public.purchase_invoices pi
   set due_amount = greatest(
         pi.grand_total - pi.paid_amount
           - coalesce((select sum(pr.applied_to_due)
                         from public.purchase_returns pr
                        where pr.purchase_invoice_id = pi.id), 0),
         0),
       payment_status = case
         when greatest(pi.grand_total - pi.paid_amount
                         - coalesce((select sum(pr.applied_to_due)
                                       from public.purchase_returns pr
                                      where pr.purchase_invoice_id = pi.id), 0),
                      0) <= 0 then 'PAID'
         when pi.paid_amount > 0 then 'PARTIALLY_PAID'
         else 'DUE' end
 where pi.status = 'RECEIVED';

commit;
