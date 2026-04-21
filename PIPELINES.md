# Month-End Reporting — Pipeline Walkthroughs

Plain-English walkthroughs of the six reconciliation pipelines. Each section describes, step by step, what the pipeline is trying to answer, what data it pulls in, the checks it runs, and what the final output tells you.

---

## 1. Pre-Check TB

**The question it answers:** *"Are there any trial balance postings in the GLs we care about? In other words, has anything already been booked before we run our recons?"*

This is a quick sanity check you run **before** anything else — a way to see whether the TB already has ECL / UWI / EIR / FVOCI entries sitting in it.

### Step 1 — Collect the GLs that matter
It reads your **EGL Mapping** file and pulls every GL number that appears in any of these columns:

`ECL_OPENING, ECL_CHARGE, ECL_WRITEBACK, ECL_WRITEOFF, ECL_PNL_CHARGE, ECL_PNL_WRITEBACK, UWI_OPENING, UWI_CHARGE, UWI_WRITEBACK, UWI_WRITEOFF, UWI_PNL_CHARGE, UWI_PNL_WRITEBACK, EIR_BS, EIR_PNL, FVOCI_BS, FVOCI_OCI`

If the mapping file has none of these, it stops and tells you.

### Step 2 — Walk through both trial balances
For every row in the MBS and MSL trial balances:
- Skip rows without an account string.
- Break the account string into parts (split by `-`) and pick out the GL segment.
- If the GL isn't in the list from Step 1, ignore it.
- Read the `PTD_NET_ENTERED` (period-to-date net amount).
- If it's non-zero, flag it as "has an entry"; otherwise "clean".

### Step 3 — Store and summarise
It records:
- Every relevant GL row, its PTD amount, and whether it's clean or not.
- How many GLs had entries ("breaks") vs. how many were clean ("matched").
- The TB effective date (for display).

**Outcome:** a short list of accounts showing which GLs already have PTD movements this month and which don't. Anything with a non-zero PTD is effectively a "warning" that something has been booked — useful to know before you start the full reconciliation.

---

## 2. Loan Recon

**The question it answers:** *"For each product type (Loan / Guarantee / Investment), does the balance shown in the TB match the sum of balances in the product files? And for Investments specifically, does it also match FIFO?"*

### Step 1 — Read the TB mapping
From the **TB Mapping** file it builds two lookups keyed on `Posting Account`:
- `Posting Account` → `Product type` (e.g. "Loan", "Guarantee", "Investment")
- `Posting Account` → list of product codes (`PRD_CODE`)

Any row without both a posting account and a product type is ignored.

### Step 2 — Find the latest reporting date
It looks at all the loaded DQ product files (LN, CC, OD, GUARANTEE, INVMT, RATING) and picks the most recent `PROC_DTE`. Everything else is done only for that latest date.

### Step 3 — Aggregate the product files
Walk through each of the loan-related product files and, for every row on the latest date:
- Translate `LEGAL_ENTITY_CODE` into an entity number (128 for MBS, 252 for MSL).
- Classify it as "Loan", "Guarantee" or "Investment" based on which file it came from.
- Add its `LEDGER_BALANCE_AMT` into two running totals:
  - One totalled by `Entity + Product Group`.
  - One totalled by `Entity + Product Group + Product Code`.

### Step 4 — Aggregate the trial balance
Walk through both TBs (MBS + MSL):
- Skip accounts that don't split into at least 4 parts.
- Build a `GL-Product` key out of the GL number and product code.
- Look up the product type from the TB mapping. If there's no match, skip.
- Add `YTD_NET_ACCOUNTED` into running totals by `Entity + Product Type` and by `Entity + Product Type + GL-Product`.

### Step 5 — Handle FIFO (Investment only)
From the FIFO file, sum up rows that are:
- `BalanceType = 'On Balance'`
- `Currency = 'SGD'`
- `Position < 0`
- Security name does **not** contain `EMMC`

This total is added to MBS (entity 128) Investment only.

### Step 6 — Build the recon rows
For each of the 6 combinations (MBS/MSL × Loan/Guarantee/Investment):
- **Product file amount** = total from Step 3.
- **FIFO amount** = only for MBS Investment; zero otherwise.
- **TB amount** = total from Step 4.
- **Variance** = TB − (Product file + FIFO).
- **Is a break?** = absolute variance ≥ **100,000**.

### Step 7 — Build the drill-down
For each of those 6 rows, it groups the underlying GL-products into "blocks" by their product-code signature so you can see, when you click in, which specific GL-products and product codes make up the totals. It also flags:
- **Unmapped GLs** — GL-products showing TB balance but no PRD_CODE mapping.
- **Unmapped PRDs** — PRD_CODEs with product-file balance but not mapped to any GL.

**Outcome:** one-line-per-group report of TB vs product file vs FIFO, with a drill-down showing exactly which GL-products and product codes drove any variance.

---

## 3. MTM FVOCI

**The question it answers:** *"What is the mark-to-market (fair value) of each FVOCI loan this month, and how much has it moved versus last month?"*

### Step 1 — Check the dates line up
Before doing any maths, it parses `PROC_DTE` from three files and runs two checks:
1. The **disbursement listing** and **current FVOCI listing** must be in the same month.
2. The **previous month FVOCI listing** must be exactly one calendar month before the current one.

If either fails, the run stops with a red warning.

### Step 2 — Compute WAIR (Weighted Average Interest Rate)
Using the **disbursement listing** (past 12 months):
- For each row, calculate:
  - `LCY balance = (RCY end bal − RCY accrued int) × exchange rate`
  - `Interest component = LCY balance × (interest rate / 100)`
- Group by `Rate Type + Currency` and, for each group, WAIR = total interest ÷ total balance.
- Also compute one overall **average WAIR** across everything (used as a fallback when a rate-type/currency combo isn't in the map).

### Step 3 — Build the prior month lookup
Read the **previous month FVOCI listing** and build a quick lookup: `UNIQUE_ID_NO → prior month LCY fair value`.

### Step 4 — Compute MTM for every current FVOCI loan
For each loan in the current FVOCI file:

**a. Pull the basic numbers** — balances, accrued interest, rate, exchange rate, repayment type, frequency, maturity, default flag, rate type, currency, facility reference.

**b. Translate to LCY** — multiply RCY figures by the exchange rate.

**c. Work out time fields:**
- **Residual months** — months from PROC_DTE to maturity (30/360 convention).
- **MOB (months on book)** — derived from the `AA_FAC_REF` (characters 2–7 give year and month the facility was opened).
- **`<6 months` flag** — "Y" if MOB is less than 6.

**d. Pick the right WAIR** — first tries `Rate Type + Currency`; if that combo isn't there, falls back to the overall average WAIR.

**e. Compute periodic payment** using the loan's repayment type and frequency:
- Type `100` with quarterly / monthly / daily schedule → annuity-style amortisation formula.
- Otherwise → straight-line interest accrual (monthly or daily).

**f. Compute market value:**
- **Periodic portion** — present value of future periodic payments discounted at WAIR, plus accrued interest.
- **Final portion** — present value of principal at maturity (only for non-`100` repayment types).
- **Total** — periodic + final, except in three cases where it's simply the LCY balance (no mark-to-market applied):
  - Residual months ≤ 12, **or**
  - Default flag = Y, **or**
  - MOB < 6 months.

**g. Compute the changes:**
- **LCY MTM change** = Market value − LCY balance.
- **RCY MTM change** = LCY change ÷ exchange rate.
- **Change vs previous month** = LCY MTM change − prior month LCY fair value (or blank if no prior record).

### Step 5 — Flag big movers
A loan is considered "above threshold" / a break if `|Change vs previous| ≥ 1,000,000`.

**Outcome:** a full listing with original columns plus MTM, WAIR, changes, and a flag for loans whose month-on-month movement is large. Three views are available: the full list, a WAIR summary, and suggested journal entries.

---

## 4. Reversal Check

**The question it answers:** *"Did this month's reversal file correctly reverse every entry booked in last month's posting file?"*

Reversals should flip the DR/CR side of the prior-month entries. For each prior-month posting, there should be a reversal with the opposite sign and the same amount.

### Step 1 — Check the dates
Before comparing any numbers:
- MBS and MSL **reversal** files must be in the same month.
- MBS and MSL **prior posting** files must be in the same month.
- The prior posting month must be exactly **one month before** the reversal month.

If any check fails, a warning is recorded and auto-run is blocked.

### Step 2 — Build aggregates for prior and reversal files
Each EGL entry already has a key: `entity|rc|gl|prod|interco|islamic|ccy|DRCR` (plus an optional `|TAG` for write-offs). The pipeline:
- Loops through both MBS and MSL dictionaries.
- Strips the write-off tag (so `…|C|ECL_WO` and `…|C` merge into one bucket).
- Skips metadata entries (those starting with `__`).
- Sums amounts into a single flat dictionary.

It does this twice — once for prior-month postings, once for reversal-month postings.

### Step 3 — Pass 1: match every prior posting to its reversal
For every key in the prior-month aggregate:
- Flip the DR/CR side of the key (D ↔ C) to build the expected reversal key.
- Look up the reversal aggregate at that flipped key.
- **Variance** = prior amount − reversal amount (should be zero if the reversal matched).
- Record a result row showing both sides.
- Mark that reversal key as "seen".

### Step 4 — Pass 2: catch unexpected reversals
Any reversal-file key that was **not** seen in Pass 1 means a reversal was booked with no prior posting backing it.
- For these, prior amount = 0 and variance = −reversal amount (everything is a break).
- They're added to the results so you can investigate.

### Step 5 — Summarise
It tracks the reversal month, any date warning, total break count and total matched count.

**Outcome:** a line-per-GL-combination showing prior amount (and side), reversal amount (and opposite side), and variance. Anything with non-zero variance is a break — either an unreversed prior entry or an unexpected reversal.

---

## 5. Posting Validation

**The question it answers:** *"For the current month, do the journal entries the RDL says should have been posted actually appear in the EGL posting file, on both DR and CR sides?"*

This is the forward check (what TB Recon does "after the fact" — Posting Validation does it at journal-entry level).

### Step 1 — Check the dates
- MBS posting date and MSL posting date must be in the same month.
- RDL date must match the posting file date(s).

If any fails, it shows a red warning and stops.

### Step 2 — Walk the RDL, generate expected DR + CR entries
For every account in the RDL (chunked so the UI stays responsive):

**a. Classify the account** using the same shared logic as TB Recon:
- Override `LEVEL_3` to "Off Balance Sheet" for BG/LC/SG.
- Override to "Rev Repo" for revrepo product types.
- Build a lookup key from `LEVEL_3 + SEC_CLS_CD + F_SHORT_TERM_IND + F_SHORT_TERM_INCEP_IND` and find the mapping row.

**b. Unmapped accounts** — if no mapping row is found, the account is parked in an "unmapped" list and skipped for posting generation.

**c. Extract dimensions** — entity (128 or 252), RC, product, currency, interco, Islamic flag, unique ID.

**d. Compute seven posting movements** (each with a DR GL + type and a CR GL + type, sourced from the mapping row):

| Amount field | DR GL / type | CR GL / type | Nature |
|---|---|---|---|
| RCY_ECL_CHARGE_FY | ECL_PNL_CHARGE / P&L | ECL_CHARGE / BS | ECL CHARGE |
| RCY_INT_UNWIND_CHARGE_FY | UWI_PNL_CHARGE / P&L | UWI_CHARGE / BS | UWI CHARGE |
| RCY_ECL_WRITEBACK_FY | ECL_WRITEBACK / BS | ECL_PNL_WRITEBACK / P&L | ECL WRITEBACK |
| RCY_INT_UNWIND_WRITEBACK_FY | UWI_WRITEBACK / BS | UWI_PNL_WRITEBACK / P&L | UWI WRITEBACK |
| RCY_ECL_WRITE_OFF_FY | ECL_WRITEOFF / BS | ECL_PNL_WRITEOFF / P&L | ECL WRITEOFF (tag: `\|ECL_WO`) |
| RCY_INT_UNWIND_WRITE_OFF_FY | UWI_WRITEOFF / BS | UWI_PNL_WRITEOFF / P&L | UWI WRITEOFF (tag: `\|UWI_WO`) |
| LCY_EIR_ADJ_AMT | EIR_BS / BS | EIR_PNL / P&L | EIR |

Zero-amount movements are dropped.

**e. Emit two legs per movement** — DR and CR:
- Build keys of the form `entity|rc|gl|prod|interco|islamic|ccy|D` and `…|C` (the CR leg carries the write-off tag where applicable).
- Add the amount into a running total for each key.
- Also remember which source account contributed (for drill-down).

At the end of this pass, the pipeline has the **expected** DR and CR bucket totals for this month.

### Step 3 — Match against the EGL posting file
- Build the union of keys from (a) the RDL-generated buckets and (b) the MBS + MSL EGL posting files.
- For each key:
  - Pick the EGL side based on the entity (128 → MBS dict, else MSL dict).
  - **Calculated** = what the RDL says.
  - **Posting file** = what the EGL actually booked.
  - **Variance** = calculated − posting file.
- Tag break rows when absolute variance > 0.

### Step 4 — Store
Results include the expected vs actual amounts, DR/CR side, BS/PL classification, nature, reporting month, unmapped accounts list, and per-leg source account breakdowns for drill-downs.

**Outcome:** a two-legged (DR + CR) line-per-combination listing. Matched rows should net to zero variance; break rows mean the RDL expected something the EGL didn't book, or vice versa.

---

## 6. TB Reconciliation

**The question it answers:** *"Does the trial balance, at the end of the month, show the balances the RDL says it should show?"*

Where Posting Validation checks the **journal entries**, TB Recon checks the **resulting balances**.

### Step 1 — Check the dates line up
- MBS and MSL trial balance dates must be in the same month.
- It auto-selects a **post-patch RDL** for the same month. If none exists, it shows a list of available RDL months so you can pick one manually.
- Final check: the selected RDL's `PROC_DTE` must match the TB date.

If anything fails, it stops with a red banner.

### Step 2 — Decide which GLs are in scope
From the **EGL Mapping** file, collect every GL number that appears in any of these columns:

`ECL_CHARGE, ECL_WRITEBACK, ECL_WRITEOFF, UWI_CHARGE, UWI_WRITEBACK, UWI_WRITEOFF, EIR_BS, ECL_OPENING, UWI_OPENING`

Only these GLs are reconciled. It also records, per GL, what **nature** it represents (for display).

### Step 3 — Build what the TB *should* look like from the RDL
For every account in the post-patch RDL:

**a. Classify the account** using the shared logic (`LEVEL_3` overrides for off-balance-sheet and rev-repo, then look up the mapping row).

**b. Unmapped accounts** go into an "unmapped" list.

**c. Extract dimensions** — entity, RC, product, currency, interco, Islamic flag, unique ID.

**d. Compute nine TB posting points** (BS-side only, with sign convention):

| Amount field | GL | Sign | Nature |
|---|---|---|---|
| RCY_ECL_CHARGE_FY | ECL_CHARGE | credit | ECL CHARGE |
| RCY_INT_UNWIND_CHARGE_FY | UWI_CHARGE | credit | UWI BS |
| RCY_ECL_WRITEBACK_FY | ECL_WRITEBACK | debit | ECL WRITEBACK |
| RCY_INT_UNWIND_WRITEBACK_FY | UWI_WRITEBACK | debit | UWI BS |
| RCY_ECL_WRITE_OFF_FY | ECL_WRITEOFF | debit | ECL WRITEOFF |
| RCY_INT_UNWIND_WRITE_OFF_FY | UWI_WRITEOFF | debit | UWI WRITEOFF |
| LCY_EIR_ADJ_AMT | EIR_BS | debit | EIR BS |
| RCY_ECL_OPENING_BAL | ECL_OPENING | credit | ECL OPENING |
| RCY_INT_UNWIND_OPENING_FY | UWI_OPENING | credit | UWI OPENING |

Zero-amount movements and movements with no GL mapped are dropped. Credit lines get flipped negative so everything can be summed.

**e. Bucket each movement** by the full account string:
`ENT-RC-GL-PRODUCT-INTERCO-00000-ISLAMIC-0000`, paired with currency.

Add the amount into a running total per bucket. Also remember which source account contributed (for drill-down).

### Step 4 — Walk the actual TB and compare
For each row in both TBs (MBS + MSL):
- Skip if the account doesn't split into at least 8 parts.
- Skip if the GL isn't in scope.
- Pull the RDL bucket for this `ACCOUNTS + CURRENCY` combination.
- Produce a result row with TB balance (`YTD_ENTERED`), expected balance (`PER_RDL`), and variance.
- Mark this bucket as "seen".

### Step 5 — Catch RDL buckets that never appeared in TB
Any RDL bucket not "seen" in Step 4 is added as its own row with `YTD_ENTERED = 0`, `PER_RDL` = the expected amount, and a pure break variance.

### Step 6 — Store
Results include all reconciliation rows, the unmapped accounts list, and the reporting month label. Clicking a row drills into the underlying source accounts that make up the RDL side.

**Outcome:** a line-per-TB-account report with three row types:
1. Appeared in both TB and RDL (may or may not have a variance).
2. Appeared in TB but not in RDL (variance = TB figure).
3. Appeared in RDL but not in TB (variance = −RDL figure).

---

## Pipeline-to-pipeline relationships

- **Pre-Check TB** is run *before* anything else — a 30-second sanity check.
- **Posting Validation** and **Reversal Check** work at the **journal-entry level** (EGL posting files vs RDL, and prior postings vs reversals).
- **TB Reconciliation** and **Loan Recon** work at the **balance level** (trial balance vs RDL / product files).
- **MTM FVOCI** is a standalone valuation calculator — it doesn't reconcile against anything, it just values and measures movement.
- All four of Posting Validation, Reversal Check, TB Reconciliation and Loan Recon share the same underlying classification logic: `LEVEL_3` + `SEC_CLS_CD` + short-term flags → EGL mapping row.
