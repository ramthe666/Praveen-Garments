/**
 * Phase 8 Part 3 — generates migration 0016 (product search: match color /
 * size / brand / category names) by EXTRACTING the two functions verbatim
 * from their source migrations and applying surgical replacements to the
 * search predicates only. No existing migration file is modified.
 * Output: supabase/migrations/0016_phase8_search_attributes.sql
 *
 * Root cause being fixed (reproduced in test-search-p3.ts):
 *   pos_search()      matched name/code/SKU/barcode/QR only — never the
 *                     color/size/brand/category names it already SELECTs.
 *   products_page()   matched name/code/variant SKU/barcode/QR only — never
 *                     color/size/brand/category/subcategory names.
 *   For a garments shop, "Blue", "XL", a brand or a category are everyday
 *   search terms; those queries returned EMPTY.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = '/home/z/my-project/supabase/migrations'

function extractBlock(src: string, fn: string): { block: string; grants: string } {
  const startMarker = `create or replace function public.${fn}(`
  const start = src.indexOf(startMarker)
  if (start < 0) throw new Error(`function ${fn} not found`)
  const end = src.indexOf('end $$;', start)
  if (end < 0) throw new Error(`end $$; not found for ${fn}`)
  const blockEnd = end + 'end $$;'.length
  const rest = src.slice(blockEnd)
  const grantLines: string[] = []
  for (const line of rest.split('\n')) {
    if (line.trim() === '') {
      if (grantLines.length > 0) break
      continue
    }
    if (/^(revoke|grant)\b/i.test(line.trim()) && line.includes(`public.${fn}(`)) grantLines.push(line)
    else break
  }
  return { block: src.slice(start, blockEnd), grants: grantLines.join('\n') }
}

function replaceOnce(block: string, fn: string, oldStr: string, newStr: string): string {
  if (!block.includes(oldStr)) throw new Error(`[${fn}] replacement source not found:\n${oldStr}`)
  const occurrences = block.split(oldStr).length - 1
  if (occurrences !== 1) throw new Error(`[${fn}] expected 1 occurrence, found ${occurrences}`)
  return block.replace(oldStr, newStr)
}

// ---------------------------------------------------------------------------
// pos_search (from 0008) — add color (c), size (s), brand (b), category (cat)
// names to the match list. All four aliases are already LEFT JOINed in the
// FROM clause, so the predicate needs no new joins.
// ---------------------------------------------------------------------------
const src0008 = readFileSync(`${ROOT}/0008_pos_billing.sql`, 'utf8')
const posSearch = extractBlock(src0008, 'pos_search')

const posOld = `      and (
        v_q = ''
        or p.name ilike '%' || v_q || '%'
        or p.product_code ilike '%' || v_q || '%'
        or pv.sku ilike '%' || v_q || '%'
        or pv.barcode ilike '%' || v_q || '%'
        or pv.qr_identifier ilike '%' || v_q || '%'
      )`
const posNew = `      and (
        v_q = ''
        or p.name ilike '%' || v_q || '%'
        or p.product_code ilike '%' || v_q || '%'
        or pv.sku ilike '%' || v_q || '%'
        or pv.barcode ilike '%' || v_q || '%'
        or pv.qr_identifier ilike '%' || v_q || '%'
        or s.name ilike '%' || v_q || '%'          -- size
        or c.name ilike '%' || v_q || '%'          -- color
        or b.name ilike '%' || v_q || '%'          -- brand
        or cat.name ilike '%' || v_q || '%'        -- category
        or sub.name ilike '%' || v_q || '%'        -- subcategory
      )`
const posJoinOld = `    left join public.categories cat on cat.id = p.category_id`
const posJoinNew = `    left join public.categories cat on cat.id = p.category_id
    left join public.categories sub on sub.id = p.subcategory_id`
const posPatched = replaceOnce(
  replaceOnce(posSearch.block, 'pos_search', posOld, posNew),
  'pos_search-subcat-join', posJoinOld, posJoinNew)

const posFinal = posPatched

// ---------------------------------------------------------------------------
// products_page (from 0004) — add category (c), subcategory (sc), brand (b)
// names at the product level and size/color names inside the variant EXISTS.
// ---------------------------------------------------------------------------
const src0004 = readFileSync(`${ROOT}/0004_products_catalog.sql`, 'utf8')
const productsPage = extractBlock(src0004, 'products_page')

const ppOld = `    v_where := v_where || format(
      '(p.name ILIKE %1$L OR p.product_code ILIKE %1$L OR EXISTS (
         select 1 from public.product_variants pv
         where pv.product_id = p.id
           and (pv.sku ILIKE %1$L OR pv.barcode ILIKE %1$L OR pv.qr_identifier ILIKE %1$L)))',
      '%' || trim(p_search) || '%'
    );`
const ppNew = `    v_where := v_where || format(
      '(p.name ILIKE %1$L OR p.product_code ILIKE %1$L
         OR c.name ILIKE %1$L OR sc.name ILIKE %1$L OR b.name ILIKE %1$L
         OR EXISTS (
         select 1 from public.product_variants pv
         left join public.sizes vsz on vsz.id = pv.size_id
         left join public.colors vcol on vcol.id = pv.color_id
         where pv.product_id = p.id
           and (pv.sku ILIKE %1$L OR pv.barcode ILIKE %1$L OR pv.qr_identifier ILIKE %1$L
                OR vsz.name ILIKE %1$L OR vcol.name ILIKE %1$L)))',
      '%' || trim(p_search) || '%'
    );`
const ppPatched = replaceOnce(productsPage.block, 'products_page', ppOld, ppNew)

// The filtered COUNT query reuses the shared WHERE but its FROM had only
// `products p` — the new c/sc/b references need the same LEFT JOINs there
// (found by test-search-p3 the moment 0016 was first applied).
const ppCountOld = `    execute format($sql$
      select count(*)
      from public.products p
      where %s
    $sql$, array_to_string(v_where, ' and ')) into v_total;`
const ppCountNew = `    execute format($sql$
      select count(*)
      from public.products p
      left join public.categories c  on c.id  = p.category_id
      left join public.categories sc on sc.id = p.subcategory_id
      left join public.brands b     on b.id  = p.brand_id
      where %s
    $sql$, array_to_string(v_where, ' and ')) into v_total;`
const ppFinal = replaceOnce(ppPatched, 'products_page-count', ppCountOld, ppCountNew)

// ---------------------------------------------------------------------------
// assemble the migration
// ---------------------------------------------------------------------------
const header = `-- 0016_phase8_search_attributes.sql
-- Phase 8, Part 3 (product-search completeness at the database layer).
--
-- PURPOSE
--   The user reported "some searches may not be working correctly".
--   Reproduction (pgtest/scripts/local/test-search-p3.ts) confirmed 9 gaps:
--   searching a COLOR ("Blue"/"black"), BRAND ("Zeya"), CATEGORY ("Kurtis")
--   or SUBCATEGORY ("Silk") returned 0 rows in BOTH search entry points:
--     pos_search()    — the POS product/scan search
--     products_page() — the catalog list page
--   SIZE ("XL") matched only accidentally when the SKU text happened to
--   contain it. Both functions SELECTed size/color/brand/category names but
--   never matched them — for a garments shop these are everyday terms.
--
--   This migration redefines ONLY the two search predicates:
--     pos_search:    name | code | SKU | barcode | QR | size | color |
--                    brand | category | subcategory (new join)
--     products_page: name | code | category | subcategory | brand | variant
--                    SKU | barcode | QR | variant size | variant color
--   All matching stays DATABASE-SIDE, case-insensitive, partial and bounded
--   (pos_search limit, products_page limit/offset) — no catalog is ever
--   loaded to the browser.
--
-- SAFETY
--   - ADDITIVE and IDEMPOTENT: create-or-replace of function bodies only.
--   - No table, column, data or grant changes (grants re-issued verbatim,
--     identical to the originals).
--   - Existing migrations 0001-0015 are untouched.
--   - Signatures and result shapes are byte-identical to the originals.
--   - New ILIKE targets are the already-joined lookup tables (sizes /
--     colors / brands / categories — tiny tables); the trigram-indexed
--     product/variant columns keep their original predicates.
--   - products_page's filtered COUNT query gains the same three LEFT JOINs
--     (categories/subcategory/brand) its rows query already had, because
--     both share one WHERE string.
--   - Apply AFTER 0015 (independent bodies, but keep the chain ordered).

`

const out =
  header +
  `-- ===========================================================================
-- pos_search  (from 0008_pos_billing.sql — search extended to attributes)
-- ===========================================================================

` +
  posFinal +
  `

revoke all on function public.pos_search(text, int) from public, anon;
grant execute on function public.pos_search(text, int) to authenticated, service_role;

-- ===========================================================================
-- products_page  (from 0004_products_catalog.sql — search extended to attrs)
-- ===========================================================================

` +
  ppFinal +
  `

revoke all on function public.products_page(text, uuid, uuid, uuid, text, text, int, int) from public, anon;
grant execute on function public.products_page(text, uuid, uuid, uuid, text, text, int, int) to authenticated;
`

writeFileSync(`${ROOT}/0016_phase8_search_attributes.sql`, out)

// diff summary: lines added vs the verbatim originals
const countDiff = (a: string, b: string) => {
  const al = a.split('\n'), bl = b.split('\n')
  return { added: bl.filter((l) => !al.includes(l)).length, removed: al.filter((l) => !bl.includes(l)).length }
}
console.log('0016 written:', `${ROOT}/0016_phase8_search_attributes.sql`)
console.log('pos_search diff lines :', JSON.stringify(countDiff(posSearch.block, posFinal)))
console.log('products_page diff    :', JSON.stringify(countDiff(productsPage.block, ppFinal)))
console.log('grants (pos_search)   :', posSearch.grants)
console.log('grants (products_page):', productsPage.grants)
