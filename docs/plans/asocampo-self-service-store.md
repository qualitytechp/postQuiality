# Plan: Asocampo — self-service store instance

**Status:** ACTIVE DESIGN. Phases 0–3 are implemented; phase 4 is pending.

Asocampo is an agricultural association running a counter-service store: no waiters,
no kitchen, no tables. Customers pick goods off the shelf and pay at a single
register. Most of the catalogue is fresh produce sold by weight, which the cashier
reads off a scale and types in.

It is a **separate instance of the same product**, not a fork: the app stays
QualityTech POS and every change below must stay generic enough that a restaurant
tenant sees no difference.

## What the product already supports

| Need | Status |
| --- | --- |
| Counter service, no tables | `service_model: 'qsr'` at setup sets `tables_required=false` and `billing_type='prepaid'` |
| No kitchen / no waiter app | `kds_enabled` and `server_app_enabled` settings |
| Colombia | `CO` → `es-CO`, `COP`, `America/Bogota`; COP resolves to **0 fraction digits** (whole pesos) |
| Weighted products | `products.sale_unit` (`each`/`kg`/`g`/`lb`), `allow_fractional_quantity`, `weight_precision` |
| Fractional order lines | `validateProductQuantity` accepts them; verified 5000 × 0.75 = 3750 COP end to end |
| Separate instance on one machine | `FLO_DEV_USER_DATA` relocates the whole data directory; ports auto-increment on collision |

## The gap

**There is no way to type a weight.** The only path that puts a fractional quantity
in the cart is `parseScaleBarcode` — a label printed by a weighing scale. Tapping a
`kg` product adds quantity 1, and the cart stepper moves in whole units.

This is not a corner case for Asocampo: **74 of 120 products are sold by the kilo**.

## Phase 0 — Test instance *(done)*

No code change. `FLO_DEV_USER_DATA` points the dev server at its own data directory,
so the store gets its own database while sharing one checkout of the code:

```sh
FLO_DEV_USER_DATA="<data-dir>" PORT=3101 KDS_PORT=3102 SERVER_APP_PORT=3103 node dev-server.js
```

Setup used `setup_profile: 'empty'`, `service_model: 'qsr'`, `country: 'CO'`,
`currency: 'COP'`, `timezone: 'America/Bogota'`, then `kds_enabled=false` and
`server_app_enabled=false`.

`business_type` stays `restaurant` — it is the only value `VALID_BUSINESS_TYPES`
accepts, and the tax pack lookup depends on it. The store model is carried by
`service_model`, not by business type.

## Phase 1 — Catalogue and customer data *(importer done; customers pending Phase 3)*

Source files are **Windows-1252, not UTF-8**; importing them without transcoding
corrupts every accented name. They must be decoded as `latin1` first.

Categories are derived from the name prefixes. Garden produce (`L.`, 64 items) is
split by plant part at the owner's request:

| Prefix | Category | Items |
| --- | --- | --- |
| `L.` | Huerta raíz / hoja / flor / fruto | 11 / 20 / 4 / 29 |
| `P.` | Café y procesados | 20 |
| `DL.` | Derivados lácteos | 12 |
| `T.` | Transformados | 8 |
| `CN.` | Cárnicos | 6 |
| `C.` | Cosmética | 6 |
| `M.` | Apícolas | 4 |

Purchase units map to sale units: `kilo` → `kg` with fractional quantities on;
everything packaged (`unidad`, `frasco`, `tarro`, `canasta`, `bolsa`, `paquete`,
`tubo`, `botella`, `litro`) → `each`.

**Catalogue CSV gained three optional columns** — `sale_unit`,
`allow_fractional_quantity`, `weight_precision` — in the template, the import and
the export. They follow the existing `tax_category` / `tax_behavior` pattern: a file
that omits a column leaves the stored value untouched, so existing importers and
exports keep working unchanged. Validation mirrors `products.ts`, including the rule
that an `each` product cannot keep fractional quantities enabled — checked against
the row the update *leaves behind*, not just the columns it carries.

Costs are imported only where cost < price. 27 rows fail that check and are left at
zero; three look like typing errors rather than thin margins (Maracuyá 3.000/100.000,
Mora 12.000/97.500, Cebolla puerro 5.500/52.500).

## Phase 2 — Manual weight entry *(done, except receipt units)*

Every product already passed through `AddonModal`, so the weight pad replaces that
modal's quantity stepper rather than adding a flow of its own — grid taps, non-scale
barcodes and cart edits all inherit it, and the restaurant path is untouched.

`frontend/src/lib/weight-input.ts` is the **single door** a weight enters through. A
serial/USB scale must call `parseWeightInput` instead of opening its own path, which
is why that function *rounds* an over-precise reading to `weight_precision` rather
than rejecting it — the pad already prevents typing one, so only a scale can produce
it, and a 0.7532 kg reading must become 0.753 rather than being dropped. It returns
null when the rounded value is zero: a weight that rounds away is not a sale.

`tests/weight-input.test.ts` asserts the parser's output against the backend's own
`validateProductQuantity`, so the two cannot drift into a state where the cashier
types a weight that fails at checkout.

Behaviour worth keeping:

- **Add is disabled until a weight is typed.** Nothing is prefilled on add — a
  default of 1 would be sold as 1 kg if the cashier forgot the scale reading.
- **The cart shows `0,750 kg` as the edit affordance**, not a ±1 stepper that would
  jump by whole kilos.
- **`itemCount()` counts a weighed line as 1.** Summing weights produced "0.75 items".
- Prices read `$5.000/kg` wherever a weighed product's unit price is shown.

**Still pending:** receipts print the bare number (`0.75`) with no unit. Adding it
touches all four printer document builders, so it is deliberately left out of this
phase.

## Phase 3 — Customer document *(done)*

The POS searches customers by phone: the field strips everything but digits and
queries `/api/customers-search`, which matched `phone_digits`, `name` or `email`.
**161 of 457 Asocampo customers have no phone**, so they were unfindable and the
cashier would have created duplicates. All of them have a national ID.

A cédula is just another digit string, so migration **v85** adds a `document` column
and folds it into that same query. The cashier types either one into the field that
already exists — **no UI change** — and a tenant that leaves the column empty sees no
difference, since an empty `document_digits` never matches.

`document_digits` is a generated column mirroring `phone_digits`, so a document
stored as `22.243.472` is found by typing `22243472`. Its index is **not** unique:
whether a document may repeat is each business's rule, not the engine's.

The form fields were added to the POS create/edit modals and the Customers page,
which also shows the document under the name.

**A migration trap worth remembering:** `PRAGMA table_info` does not list VIRTUAL
generated columns — only `PRAGMA table_xinfo` does. The first version of v85 used
`getColumns()` (which wraps `table_info`) to test for `document_digits`, so on replay
it tried to add the column again and failed with *duplicate column name*. The
upgrade-path test caught it. Migration v22 (`phone_digits`) carries the same latent
bug; it has never surfaced because nothing replays from below v22.

Import notes: 3 blank rows, 9 duplicate IDs skipped, and rows carrying two phone
numbers in one cell. Landlines and malformed numbers are kept verbatim in the
customer's notes rather than dropping the person — the API takes a name alone.
The write rate limit (60/min) is a deliberate protection, so the importer paces
itself to it and re-reads what already exists so it can resume without duplicating.

A **`Ventas en caja`** customer covers unregistered walk-ins, so `Cliente obligatorio`
can stay on without holding up the queue. It has no phone on purpose — an invented
number could belong to a real person and receive WhatsApp receipts — and a short
document number instead, which is what makes it typeable in the POS field.

## Phase 3b — Friendlier required-customer search *(done)*

`Cliente obligatorio` existed before this plan and works the same everywhere: it
blocks `handlePlaceOrder` until `cart.customerId` is set. What it opened, though, was
`CustomerSearch` — a widget built for a quick phone-driven lookup, not for browsing.
Typing a name into its phone field does nothing (it strips non-digits before
searching), so a frequent customer whose phone the cashier doesn't remember was
simply unreachable, and the only way out of the dialog was the X — which reopens on
the next "Confirmar pedido" since nothing was resolved. Not tied to Asocampo: any
tenant that turns this setting on inherits the same dead end.

`CustomerPickerModal` (`frontend/src/components/pos/CustomerPickerModal.tsx`)
replaces it **only in that one dialog** — the topbar's quick-attach `CustomerSearch`
is untouched. It free-text searches `/customers-search` (already generic: name,
phone, and — since Phase 3 — document, matched together, no per-field logic to
extend when a business wants "search by member ID" or similar), lists matches to
tap, and falls through to `CreateCustomerModal` when nothing matches.

Below the list sits a deliberate escape hatch: **"Continuar sin cliente."** Skipping
is a per-sale choice, not a setting — turning `Cliente obligatorio` back off would
remove the prompt for everyone; this lets one occasional sale through while the next
order asks again. Implemented as `skipCustomerCheckRef` (a ref, not state) in
`pos/page.tsx`: the skip handler sets it and calls `handlePlaceOrder()` in the same
tick, and a `setState` from that same tick would not have applied yet when the
function closure re-reads it — a stale read would silently re-open the same prompt.
The ref is consumed (reset to `false`) the instant the guard clears, so it only ever
covers the one order it was invoked for.

## Phase 2b — Physical-keyboard weight entry *(done)*

`WeightPad`'s "Peso" value was a `<span>` — a display, not a field. On a real
till with a keyboard and mouse (not the touch-only setup the first pass assumed),
that meant no focus to land on and no way to type a reading at all. It's now a real
`<input>`, autofocused (and its text selected) the moment the modal mounts — one
instance per product opened, so "on mount" is exactly "on open" without stealing
focus back while the cashier is already typing.

Both entry paths — this input and the on-screen `TouchNumberPad` — now run through
the same `handleTyped`, which chains `acceptsWeightKeystroke` (the existing
per-keystroke precision filter) and the new `clampWeightValue` (extracted from the
sanity cap `TouchNumberPad` already applied internally, so physical typing cannot
bypass it by skipping the touch buttons). One filter, two doors — the integrity
concern the change was asked to respect.

## Phase 4 — Finishing *(pending)*

Receipt branding, cash open/close (already built), and reports.

## Open questions

1. ~~Three products priced by the litre.~~ **Settled:** the owner confirmed goat milk
   and both goat yoghurts are sold bottled, so `each` is correct and `sale_unit`
   needs no volume unit.
2. **`Cliente obligatorio` is on**, so every sale demands a customer. The
   `Ventas en caja` customer covers walk-ins; the owner decides at testing whether to
   keep the setting on.
