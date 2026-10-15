# Sprint 11 — Approval rules: what tier-1 ERPs do, and what we should build

Written 2026-10-15 for BR-JNL-10 (Blueprint FR-APR-01..06). Based on the documented behaviour of SAP S/4HANA, Oracle Fusion / NetSuite, Microsoft Dynamics 365 Finance and Odoo as I know them; not re-verified against current vendor documentation, so confirm details before quoting them externally.

## 1. How the four compare

| Aspect | SAP S/4HANA | Oracle Fusion (and NetSuite) | Dynamics 365 Finance | Odoo / mid-market |
|---|---|---|---|---|
| Mechanism | Release strategies (purchasing), Flexible Workflow (finance: journal, payment, bank), parked documents | Approval Management Engine / BPM rules; NetSuite SuiteFlow + approval routing | Workflow editor: conditions, tasks, approval steps, escalation | Approval rules per model (some editions) |
| What triggers it | Document type + amount + characteristics (company code, cost centre, plant) | Document type, amount, supplier, department, requester | Document type + conditions on any field (amount, legal entity, vendor group) | Amount threshold per document type |
| Levels | Sequential or parallel release codes; up to 8 levels (purchasing) | Approval chain by hierarchy (manager chain) or fixed list; parallel/serial | Multi-step, sequential, parallel, "any one / all" | One or two levels |
| Approver resolution | Release code → user via authorisation; org-structure, rules | Supervisor hierarchy, job level, position, user list, group | User, role, position hierarchy, "manager of submitter", queues | User or group |
| Self-approval | Prevented by separation of duties (SoD) rules and "no approve own" setting | Prevented by default (submitter skipped in chain) | Option "submitter cannot approve"; SoD rules | Configurable |
| Delegation / absence | Substitutes, "workflow substitutions" with validity dates | Delegation rules with dates; reassign | Delegation, out-of-office, reassignment | Limited |
| Escalation / timeout | Deadline monitoring, escalate to superior | Escalate after N days, auto-approve or reject options | Timeouts with escalation | Rare |
| What is held | Parked/blocked document; **nothing posts** until released; payment run excludes blocked items | Document "Pending Approval", no accounting until approved | Document "In review"/"Submitted"; posting blocked | Draft |
| Rejection | Back to originator with comment; can be recalled | Rejected → originator edits and resubmits; reject reasons | Reject/return/request change with comment | Back to draft |
| Audit trail | Change documents + workflow log (who, when, decision, comment) | Approval history on the document; full audit | Workflow history, immutable | Chatter log |
| Amount change after approval | Release resets if value rises beyond a tolerance | Re-approval if amount changes | Document locked while in workflow; edit recalls it | Usually re-approve |
| Payments | Payment approval via bank-communication workflow; dual control on payment files (four-eyes) | Payment batch approval; bank-file release | Payment journals have their own workflow; positive pay | Usually none |

## 2. Principles every tier-1 system shares (these are the requirements, regardless of vendor)

1. **Rule-driven, not blanket.** Only documents matching a rule enter approval; everything else posts directly (our FR-APR-06). Approval is overhead on high-value or sensitive items.
2. **Nothing hits the ledger (or releases funds) until approved.** The document sits in a pre-posted state (parked / pending); reports and subledgers never see it.
3. **Separation of duties enforced by the server.** The submitter can never approve their own item at any level; a second control is that approvers cannot approve beyond their own authority limit.
4. **Authority by amount band and by role**, not by named person alone; approvers are resolved from roles / hierarchy so staff changes do not break rules.
5. **Sequential levels above higher thresholds**, with parallel/any-of options at one level.
6. **Immutable history:** who, when, level, decision, remarks; visible on the document.
7. **Changing a pending document invalidates approvals** (edit = recall and resubmit, or re-approve if the amount rises).
8. **Delegation and escalation** for absence and delay (substitute with validity dates; escalate after a timeout).
9. **Rejection returns to the submitter with remarks**; nothing rejected ever posts.
10. **Payments are the strictest case:** dual control, and blocked payments are excluded from payment runs.

## 3. What we already have (do not rebuild)

* Manual journals: Draft → Pending → Posted with maker-checker, rejection with reason, optional self-approval switch, event history (`manual_journals`, `manual_journal_events`). This is a **single-level, always-on** rule hard-wired into the journal route.
* Posting guard, audit log, permission registry, per-document posting paths.
* Documents that post immediately today: vendor bills, expenses, receipts, vendor payments, credit notes.

## 4. Recommended design for Sprint 11 (fits our architecture)

**One generic approval engine, not one workflow per document.** The manual-journal maker-checker becomes the first *client* of the engine; bills, payments and credit notes follow.

### 4.1 Data (all company-scoped, RLS, composite keys)
* `approval_rules` — company, document type (`Journal`, `VendorBill`, `VendorPayment`, `CreditNote`, later `Receipt`, `Expense`), name, active, **amount from / to**, optional conditions (branch, vendor, currency-free), priority, effective dates.
* `approval_rule_levels` — rule, level number, approver type (`Role` | `User` | `Permission`), approver id, mode (`Any one` | `All`), optional amount ceiling per level, escalation days.
* `approval_requests` — one per submitted document: document type + id, rule used (snapshot of the levels at submit time), status (`Pending`, `Approved`, `Rejected`, `Recalled`), current level, amount at submit, submitter, timestamps.
* `approval_actions` — request, level, actor, action (`Approved`, `Rejected`, `Delegated`, `Escalated`, `Recalled`), remarks, time. Append-only.
* `approval_delegations` — delegator, delegate, document types, valid from/to.

### 4.2 Engine behaviour
1. A document route calls `submitForApproval(type, id, amount)` instead of posting. The engine finds the matching active rule (lowest priority number wins; band by amount); **no match → returns "post directly"** (FR-APR-06).
2. A match creates the request, sets the document status to *Pending Approval* and posts **nothing**. Vendor payment: no voucher, no bank movement, excluded from any payment run.
3. `decide(requestId, level, action, remarks)` is the only way forward: checks the caller holds the level's authority (role/permission/delegation), **is not the submitter** (FR-APR-03, server-side), and has not already acted at an earlier level.
4. Last level approved → the engine calls the document's own **post function** inside the same transaction; the posting guard runs again at that moment (as manual journals do today).
5. Reject → document returns to *Draft* with remarks; edit of a pending document recalls the request; an amount increase restarts approval.
6. Everything is audited and shown in the document's history; a worklist screen ("My approvals", with counts in the menu) lists what waits for the signed-in user.

### 4.3 Screens
Approval Rules (list, rule editor with levels and amount bands, test-a-document preview), My Approvals (worklist, bulk approve for same-rule items), history panel on every document, delegation settings.

### 4.4 Permissions
`approvalRules` (create, read, update, delete); `approvals.decide` is **not** a global right: authority comes from the rule's level (role/permission), so a person can approve vendor payments up to a band without being able to approve journals. Optional `approvals.override` for an owner emergency approval, audited.

### 4.5 Rollout safety
* Default = **no rules** = today's behaviour exactly (journals keep their single-level flow until an owner defines a rule, then the engine takes over).
* Migrate journals last, after bills and payments prove the engine.
* Tests: threshold boundary (equal to / just above), two-level chain, submitter never approves, same person cannot approve two levels, delegation window, amount change restart, rejection path, posting guard re-check at approval, payment excluded until approved, cross-company isolation.

## 5. Decisions needed from the owner before building

1. **Which documents first?** Recommended: vendor payments and vendor bills (money out), then credit notes, then fold manual journals into the engine.
2. **Approver model:** roles only (simplest), or roles plus the user's manager hierarchy? Our users have roles but no manager hierarchy today; recommended roles + named users in v1.
3. **Self-approval:** keep today's company-level switch for journals, or forbid absolutely for payments (recommended: absolute for payments).
4. **Currency of thresholds:** company currency only (single-currency scope).
5. **Delegation and escalation in v1?** Recommended: delegation yes (absence is real), escalation to v1.1.
6. **Approval by email/mobile?** Recommended: not in v1 (in-app worklist and notification count only).
7. **Should reopening a bank reconciliation, overriding the lock date or back-dating also route through approval?** Tier-1 systems usually keep these as authority rights, not workflow; recommended: keep as rights.

## 6. Out of scope for S11
Parallel multi-branch routing by cost-centre hierarchy, e-signature, scheduled auto-approve, approval by external email links.

## 7. Owner decisions (2026-10-15) — binding for Sprint 11

1. **Order:** vendor payments and vendor bills first, then credit notes, then manual journals folded into the engine.
2. **Approvers:** roles **and** the manager hierarchy. Users gain a manager link (`users.manager_id`, additive, nullable) and a rule level may name "manager of the submitter" (and the manager's manager, up to N steps) besides a role, a user or a permission.
3. **Self-approval:** a **company-level setting in General Ledger settings**, on or off. Off (the default) = a submitter can never approve their own document at any level; on = allowed, the document is flagged "self-approved" and the setting change and every use are audited. The setting covers payments, bills and credit notes as well as journals (today's journal switch becomes this one setting).
4. **Delegation with validity dates in version 1; escalation after a timeout in 1.1.**
5. **Notification inside the system only:** a "My approvals" worklist and a count in the menu. No email or mobile.
6. **Back-dating, lock-date override and reopening a reconciliation remain authority rights**, not workflow.
