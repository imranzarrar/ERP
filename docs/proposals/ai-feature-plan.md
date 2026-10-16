# AI Features — Implementation Plan (for review)

Status: **proposal, nothing built yet.** Written 2026-09-20 against the current codebase.
Focus, as requested: **(1) reporting / data processing, (2) easier data entry and validation, (3) scenarios that can be configured, not hard-coded.**
Worked scenarios: ZATCA rejection analysis, sales trends, WhatsApp message → quotation.

---

## 1. Principles (the rules every feature follows)

1. **The AI never touches the database.** The VPS calls the AI provider outward. The model can only *ask* our server to run a named, read-only "tool"; our server runs it (as the logged-in user, for their company only) and sends back a small result. No credentials, no inbound access, no model-written SQL.
2. **Drafts, never postings.** Anything that would create or change a document (quotation, expense, GRN) is created as a **Draft** marked "AI-created", and a person approves it. Nothing is posted, filed with ZATCA, or sent to a customer automatically.
3. **Rules first, AI second.** Validation that can be done with code (VAT arithmetic, duplicates, open-month dates, unit mismatches) is done with code. The AI explains, suggests, and handles messy input (photos, chat text).
4. **Reuse what exists.** Every reporting answer comes from the existing server-side report functions in `server/lib/financialReports.ts` (company-scoped, uncapped, permission-gated). No second copy of business math.
5. **Metered and capped from day one.** Every call is counted against the company's plan; a spending cap exists at the provider as a safety net.
6. **Provider-neutral.** A thin adapter, so a feature can move to another model by changing a setting.
7. **Small payloads.** Send aggregates and the few columns needed; never phone numbers, emails or VAT numbers unless the scenario truly needs them.

---

## 2. Architecture

```
Browser ──► our server (Express)
              │  AI Gateway  (server/lib/ai/)
              │   ├─ Scenario registry   → which prompt, tools, output shape, model tier, permission, credits
              │   ├─ Tool registry       → read-only functions over existing report code / drafts
              │   ├─ Guard               → user permission + company scope + plan credits + rate limit
              │   ├─ Provider adapter    → Claude / Gemini / OpenAI (one interface)
              │   └─ Audit + Metering    → who, which scenario, tools called, rows sent, tokens, cost
              ▼
        AI provider API  (question + tool list only; data comes back only via approved tools)
```

Request flow: user asks → gateway checks permission/credits → model picks a tool → **our** server runs it under the user's identity (RLS + `req.targetCompanyId` apply exactly as today) → capped result returned to the model → answer + optional chart/table → audit row written.

Placement in the repo: `server/lib/ai/{gateway,scenarios,tools,providers,metering}.ts`, routes `server/routes/ai.ts`, all new tables with RLS per `.claude/skills/rls-tenant-isolation`.

---

## 3. "Configurable scenarios" — the core idea

A **scenario** is a configuration record, not code. Adding most new questions/workflows means adding a row, not shipping a release.

| Field | Meaning |
|---|---|
| `key`, `name`, `description` | e.g. `zatca_rejection_analysis` (translated en/ar/ur) |
| `entry_points` | where it appears: global "Ask" box, a button on a screen (e.g. on a rejected invoice), a schedule, or a channel (WhatsApp) |
| `instructions` | the prompt template (editable, versioned) |
| `allowed_tools` | which tools it may use (read-only list) |
| `output_kind` | `text`, `table`, `chart`, `draft_quotation`, `draft_expense`, `validation_report` |
| `output_schema` | JSON schema the answer must match (validated by our code before showing) |
| `model_tier` | `small` (default) or `standard`; automatic step-up if confidence is low |
| `required_permission` | existing permission leaf (e.g. `reports.salesRegister`) — the user must already have it |
| `credits` | cost per run, for plan metering |
| `write_mode` | `read_only` or `creates_draft` (never "posts") |
| `enabled_by_plan` / per-company toggle | who can use it |
| `example_questions` | shown as one-click suggestions; also used as the test set |

**Who edits what**
- Super-admin: create/edit scenarios, prompts, tool lists, per-plan availability, with a **test console** (run a scenario against demo data and see tools called, tokens, cost).
- Company admin: switch scenarios on/off and add company-specific suggested questions.
- New *tools* (a new data source) still need a developer; new *questions and workflows* over existing tools do not.

Stored in `ai_scenarios` (+ `ai_scenario_versions` for history/rollback). Seeded from code so a fresh install works.

---

## 4. Tool catalogue (all read-only unless noted)

Built on functions that already exist, wrapped with row caps (e.g. top 50 + full totals) and column allow-lists:

| Tool | Backed by | Used by |
|---|---|---|
| `outstanding_receivables(customer?, overdue_days?)` | `computeOutstanding` | pending invoices, collections |
| `sales_trend(period, group_by)` | **new** `computeSalesTrend` (time-bucketed, uses `computeInvoiceTotalsMap`) | sales trends |
| `sales_register`, `sales_by_item`, `sales_by_staff`, `customer_statement` | existing | Q&A |
| `stock_valuation`, `low_stock`, `stock_movement(product)` | existing | stock questions |
| `vat_summary`, `profit_loss`, `bank_ledger` | existing | finance Q&A |
| `zatca_submission(invoice)` / `zatca_rejections(period)` | invoice `zatcaStatus` + `zatcaValidationResults` (already stored) | ZATCA analysis |
| `find_customer(name/phone)`, `find_product(text)` | customers/products + packaging units | WhatsApp, data entry |
| `product_price(product, unit, customer?)` | price data incl. packaging (outer/carton) | quotation drafting |
| **`create_quotation_draft`**, **`create_expense_draft`** | existing create routes, status `Draft`, flagged AI-created | drafts only |

---

## 5. The scenarios you asked about

### 5.1 ZATCA rejected invoice analysis (read-only)
- **Trigger:** "Why was this rejected?" button on an invoice with status `REJECTED`/`ERROR`; also "Analyse this week's rejections" from the ZATCA screen.
- **Data:** the invoice's stored `zatcaValidationResults` (error codes/messages) — the only thing sent. No customer contact data.
- **Grounding:** a curated **ZATCA error-code knowledge file** (code → plain meaning → where to fix it in this app). The model must cite the code; unknown codes are reported as "unrecognised" rather than guessed. Built once from ZATCA's published rules and the errors we have already seen (see `docs/zatca/`).
- **Output:** cause in plain language (en/ar/ur), exact field/screen to correct, and — for batches — rejections grouped by cause with counts ("7 invoices: missing buyer VAT number").
- **Guardrails:** never resubmits, edits, or cancels. The existing rule stands: a cleared/reported invoice is only reversed by a Credit Note.
- **Success test:** for a fixed set of real rejections, the explanation names the right code and the right fix ≥ 90% of the time.

### 5.2 Sales trends (read-only, also scheduled)
- **Trigger:** "Ask", a "Explain this" button on the Dashboard/Sales Reports, and a **weekly/daily brief** (WhatsApp/email) per company.
- **Flow:** `sales_trend` for this vs previous period, by item/customer/branch → the model writes the story (growth, top movers, customers who stopped buying, seasonality) and returns a **chart spec** the existing Recharts UI renders.
- **Numbers are never invented:** every figure in the text must come from a tool result; the gateway checks the answer's numbers against the returned data and rejects mismatches.
- **Extras:** slow/dead stock, "who is late paying" (from `outstanding_receivables`), reorder suggestions from the stock ledger.

### 5.3 WhatsApp message → quotation draft (creates a draft)
- **Channel:** WhatsApp Business Cloud API webhook → `POST /api/public/whatsapp/:channelId` (signature-verified). Each company registers its number; a sender's phone is matched to a customer.
- **Understands:** text, voice notes (transcribed), and photos of handwritten lists. Arabic/Urdu/English, and packaging words ("outer", "carton", "dozen") mapped to the product's packaging units.
- **Steps:** extract lines (item, qty, unit, price if stated) → `find_customer` / `find_product` (fuzzy match, SKU, barcode) → `product_price` → create a **Draft quotation** (status `Draft`, source `whatsapp`, link to the original message).
- **Ambiguity handling:** unresolved items are kept as flagged lines ("could not match: 'كرتون زيت'"), not guessed; an optional clarifying reply asks the customer ("Which size: 1L or 5L?").
- **Review:** the salesperson gets an in-app notification and sees the draft in the **AI Drafts** inbox with the original message beside it (confidence per line), then edits/approves/rejects. Only after approval can it be sent to the customer. A configurable auto-reply ("Received, we'll send your quotation shortly") is the only thing sent automatically.
- **Safety:** unknown senders create no data (they get a generic reply); per-sender rate limit; message bodies stored only as long as the draft exists (configurable).

---

## 6. Data entry & validation (the "make it easy" part)

**Capture → draft**
- **Supplier bill / receipt capture:** photo or PDF → Expense or GRN draft (vendor, date, lines, VAT, totals, the ZATCA QR if present). Vendor and products matched to existing masters; category and tax slab suggested from history.
- **Autofill suggestions** while typing (category, tax slab, unit, price from last purchase).

**Validation assistant (deterministic checks; AI only explains)**
- VAT arithmetic wrong; total ≠ lines; date outside the open fiscal month.
- Duplicate expense (same vendor + amount + date) or duplicate bill number.
- Missing/invalid buyer or vendor VAT number (15 digits) before ZATCA submission — catches many rejections *before* they happen.
- Unit mix-ups (outer vs base) and quantities that look off versus history; negative-stock heads-up with the source document.
- Unusual discounts, price changes, POS voids (anomaly flags for owners).
Output is a short list of "fix these N things" with a one-click jump to the field. Pre-submission ZATCA validation is the highest-value item here.

---

## 7. Data model (new tables; all with `company_id` + RLS policy)

| Table | Purpose |
|---|---|
| `ai_scenarios`, `ai_scenario_versions` | configurable scenarios (+ history) |
| `ai_company_settings` | per-company enable/disable, plan, credit balance, monthly caps |
| `ai_usage` | one row per call: company, user, scenario, model, input/output tokens, cost, time |
| `ai_requests` | audit: tools called, row counts sent, outcome (prompts stored redacted/hashed) |
| `ai_drafts` | links an AI-created draft (quotation/expense) to its source (message/bill), confidence, review state |
| `whatsapp_channels`, `whatsapp_messages` | number ↔ company mapping, inbound/outbound log |

Schema classification (per the deploy checklist): **all new tables and nullable columns — safe to `db:push` directly.** A small `source` column on quotations/expenses (nullable) marks AI-created drafts. RLS policies must be applied with `scripts/apply-rls-policies.mjs` after the push.

---

## 8. Metering, plans and cost control

- **Credits per scenario** (text question = 1, ZATCA analysis = 2, bill capture = 3, WhatsApp draft = 3 — tunable). Balance decremented **atomically** in one SQL statement so concurrent requests can't overspend.
- Limits: monthly allowance per plan, per-user rate limit (e.g. 10/min), per-request input/output caps, and a hard monthly spend cap at the provider.
- **Cost model** (Anthropic list prices, Sept 2026): a typical question (~4k in / 500 out) ≈ **$0.0065 on Haiku 4.5**, ≈ $0.013 on Sonnet 5; Gemini Flash-Lite ≈ $0.0006. Prompt caching cuts repeated context ~90%; overnight batch jobs (weekly briefs) ~50%. Rule: **AI cost per company ≤ 5–10% of its subscription price**; features that can't meet it go to a higher plan.
- UI: "X credits left", usage dashboard for admins, upgrade prompt at the limit.

---

## 9. Model & privacy choices

- **Development/testing:** free tiers with **demo data only** (free tiers may train on inputs and have tiny limits — never real customer data).
- **Production:** a **paid** tier with no-training terms. Default `small` model (e.g. Claude Haiku 4.5 or a comparable cheap model), step up to `standard` only for hard questions. Choose after an **evaluation harness** (50 real-style Arabic/Urdu/English questions, bills, ZATCA errors, WhatsApp messages) scores 2–3 candidates on accuracy and cost.
- Avoid providers that process data in jurisdictions Saudi customers won't accept; check PDPL implications before promising anything; state provider and retention in the privacy policy.

---

## 10. UX

- **Ask** panel (global, all languages, RTL-correct) with per-role example questions from the scenario config.
- **Contextual buttons:** "Why rejected?" on invoices, "Explain" on charts, "Check before submit" on invoice/expense forms.
- **AI Drafts inbox:** every AI-created document, its source (WhatsApp message / bill photo), confidence per line, approve / edit / reject.
- **Admin → AI:** scenario library, test console, per-company toggles, usage and credits.
- All strings via `t()` with ar/ur entries (per `ux-translation`); print/PDF unaffected.

---

## 11. Phased roadmap

| Phase | Deliverable | Size |
|---|---|---|
| **0 Foundation** | gateway, provider adapter, tool registry, scenario tables + seeds, metering/credits/rate limits, audit, evaluation harness, admin test console | M–L |
| **1 Reporting (read-only)** | "Ask" over existing reports, sales-trend tool + explain, **ZATCA rejection analysis** (+ error knowledge file), weekly brief | M |
| **2 Data entry & validation** | pre-submission validation assistant, duplicate/anomaly checks, bill capture → expense/GRN drafts, AI Drafts inbox | L |
| **3 WhatsApp → quotation** | channel setup, webhook, extraction/matching, draft + review flow | L |
| **4 Proactive** | collections reminders (drafts), reorder suggestions, anomaly alerts, scheduled briefs per company | M |

Phase 1 is deliberately first: lowest risk, visible value, and it exercises the whole foundation.

---

## 12. Risks and how they are handled

| Risk | Mitigation |
|---|---|
| Wrong number in an answer | numbers come only from tool results; gateway cross-checks figures in the text against the data; otherwise the answer is rejected |
| Model "hallucinates" a ZATCA fix | grounded in the curated code file; must cite the code; unknown → "unrecognised" |
| Prompt injection (text inside a customer name, note, or WhatsApp message) | tools are read-only or draft-only; tool results treated as data; drafts need human approval |
| Cross-company data exposure | AI runs only through existing tenant-scoped code + RLS; isolation tests extended to AI tools |
| Cost blow-up | credits, rate limits, request caps, provider hard cap |
| Poor Arabic/Urdu quality | evaluation harness on real samples before choosing a model; per-language scores tracked |
| WhatsApp abuse/spam | signature verification, sender→customer mapping, per-sender limits, no data created for unknown senders |
| Provider outage/price change | adapter allows switching; features degrade gracefully ("AI unavailable"), ERP unaffected |

---

## 13. Testing and acceptance (project rule: tests + real-browser UAT)

- Unit/integration tests for every tool (scoping, caps, permissions), the metering atomicity (concurrent requests can't overspend), scenario validation, and webhook signature checks; extend `scripts/verify-tenant-isolation.ts` style checks to AI tools.
- Evaluation sets per scenario (kept in the repo) with pass thresholds; rerun on any prompt/model change.
- Browser UAT for each screen; a red-team pass for prompt injection.
- Nothing ships without: tests green, isolation check green, eval thresholds met, credits verified in the UI.

---

## 14. Decisions needed from you

1. **Provider(s):** shortlist to evaluate (suggest: Claude Haiku 4.5, Gemini Flash-Lite paid, one OpenAI small model).
2. **WhatsApp route:** Meta Cloud API directly vs a provider (Twilio / 360dialog); who owns the business number per company.
3. **Plans:** which tiers include AI and how many credits (needs your price points and expected number of companies).
4. **Approval policy:** always require human approval for AI drafts (recommended), or allow auto-approve for trusted customers later.
5. **Languages** to prioritise for the first evaluation (Arabic, Urdu, English — order).
6. **Data retention:** how long to keep WhatsApp messages/bill images and AI audit logs.
