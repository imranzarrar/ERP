import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and, isNotNull, desc, sql } from 'drizzle-orm';
import { isSuperAdminUser } from '../lib/authz.js';
import { generateId } from '../../src/id.js';
import { provisionStarterResources } from '../lib/companyProvisioning.js';
import { isMailerConfigured, sendOnboardingEmailConfirmation, sendOnboardingReceivedEmail, sendOnboardingApprovedEmail, sendOnboardingRejectedEmail } from '../lib/mailer.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Two routers: `publicRouter` is mounted BEFORE isAuthenticated in server.ts (the same
// pre-line-603 block as /api/auth/forgot-password) since this is the one write endpoint
// in the whole app reachable with no session at all. `adminRouter` is mounted after, for
// the review/approve/reject actions.
//
// Full flow, in order: (1) POST /onboarding-requests stores a Pending row and emails
// ONLY the contact a confirmation link — no super-admin is notified yet, since nothing is
// known to be real at this point. (2) POST /onboarding-requests/confirm-email consumes
// that link, sets emailVerifiedAt, and only THEN emails every super-admin that a request
// exists to review. (3) The admin queue (GET /admin/onboarding-requests) shows every
// request either way, verified or not, so an admin can Reject a clearly-bogus one without
// waiting on anything — but (4) POST /admin/.../approve refuses (400) any request whose
// emailVerifiedAt is still null, enforced server-side so a direct API call can't bypass a
// merely-disabled UI button. (5) POST /admin/.../resend-confirmation lets an admin issue a
// fresh link if the original (1-hour) one expired unused.
export const publicRouter = express.Router();
export const adminRouter = express.Router();

function cap(value: any, maxLen: number): string {
  return String(value || '').trim().slice(0, maxLen);
}

// Plain in-process sliding-window rate limiter — no new dependency, fine for this app's
// single-VPS PM2 deployment (each cluster worker tracks its own window independently,
// which only makes the effective limit slightly more generous under multiple workers,
// never less safe). Pruned lazily on each check rather than a background timer.
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX_PER_WINDOW = 5;
const submissionTimestampsByIp = new Map<string, number[]>();
function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const existing = (submissionTimestampsByIp.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (existing.length >= RATE_LIMIT_MAX_PER_WINDOW) {
    submissionTimestampsByIp.set(ip, existing);
    return true;
  }
  existing.push(now);
  submissionTimestampsByIp.set(ip, existing);
  return false;
}

// --- Public: submit a new onboarding request ---
publicRouter.post('/onboarding-requests', async (req: any, res) => {
  // Never reveals anything about *why* a submission was dropped (honeypot, rate limit) —
  // always the same generic success, matching forgot-password's own account-enumeration-
  // safe convention. This is the one write endpoint in the app reachable with no session.
  // Wording deliberately doesn't say "received" — nothing reaches a human (super-admin)
  // until the contact confirms their email; this is really "check your inbox next."
  const genericResponse = { message: 'Thank you — check your email to confirm your address and complete your submission.' };

  try {
    // Email confirmation is the whole point of this route — with no mailer, a submission
    // could never be verified and would sit forever un-approvable. Fails loudly (unlike
    // the silent honeypot/rate-limit drops below) since this is a real server
    // misconfiguration, not something to hide from a legitimate submitter.
    if (!isMailerConfigured()) {
      return res.status(503).json({ error: 'Company registration is not available right now. Please contact us directly.' });
    }

    // Honeypot: a field real browsers never fill in (hidden via CSS on the form, never
    // shown to a human). A bot filling every field trips this; a real submitter can't.
    if (String(req.body?.website || '').trim() !== '') {
      return res.json(genericResponse);
    }

    const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
    if (isRateLimited(ip)) {
      return res.json(genericResponse);
    }

    const companyName = cap(req.body?.companyName, 200);
    const companyEmail = cap(req.body?.companyEmail, 200).toLowerCase();
    const contactName = cap(req.body?.contactName, 200);
    // The individual contact's own email is optional — the company email is the only
    // email actually required on this form. When left blank, the company email doubles
    // as the contact email (it becomes the new user's username/login at approval time —
    // see the approve route below), so the rest of the pipeline never needs to special-
    // case a missing contact email.
    const contactEmailRaw = cap(req.body?.contactEmail, 200).toLowerCase();
    const contactEmail = contactEmailRaw || companyEmail;

    if (!companyName || !contactName || !EMAIL_RE.test(companyEmail) || (contactEmailRaw && !EMAIL_RE.test(contactEmailRaw))) {
      return res.status(400).json({ error: 'Company name, a valid company email, and contact name are required. If provided, the contact email must be valid.' });
    }

    // Duplicate check, by explicit product decision — unlike the honeypot/rate-limit
    // checks above (which stay silent to avoid confirming anything to a bot), a real
    // prospective customer needs to know why their submission didn't go through. The
    // contact email becomes the new user's username/login at approval time (see the
    // approve route below), so a collision here would otherwise surface confusingly late.
    const [existingUser] = await db.select({ id: schema.users.id }).from(schema.users)
      .where(sql`LOWER(${schema.users.email}) = ${contactEmail}`);
    if (existingUser) {
      return res.status(409).json({ error: 'An account with this email already exists. Please contact your administrator if you believe this is a mistake.' });
    }
    const [existingRequest] = await db.select({ id: schema.companyOnboardingRequests.id })
      .from(schema.companyOnboardingRequests)
      .where(and(eq(schema.companyOnboardingRequests.contactEmail, contactEmail), eq(schema.companyOnboardingRequests.status, 'Pending')));
    if (existingRequest) {
      return res.status(409).json({ error: 'A pending onboarding request with this email already exists. Please wait for it to be reviewed.' });
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const request = {
      id: generateId(),
      companyName,
      companyEmail,
      companyPhone: cap(req.body?.companyPhone, 50) || null,
      companyAddress: cap(req.body?.companyAddress, 500) || null,
      vatNumber: cap(req.body?.vatNumber, 50) || null,
      crNumber: cap(req.body?.crNumber, 50) || null,
      currency: cap(req.body?.currency, 10) || 'SAR',
      contactName,
      contactEmail,
      contactPhone: cap(req.body?.contactPhone, 50) || null,
      notes: cap(req.body?.notes, 2000) || null,
      status: 'Pending' as const,
      emailConfirmTokenHash: tokenHash,
      emailConfirmExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    };

    await db.insert(schema.companyOnboardingRequests).values(request);

    // Fire-and-forget — a mail failure must never block the submission itself, matching
    // forgot-password's own pattern exactly. The admin-notification email doesn't fire
    // here at all anymore — see the confirm-email route below, which sends it only once
    // this address is actually confirmed.
    const origin = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const confirmUrl = `${origin}/?confirmOnboardingToken=${rawToken}`;
    sendOnboardingEmailConfirmation(contactEmail, confirmUrl, companyName).catch((err: any) => {
      console.error('[Onboarding] Failed to send confirmation email:', err.message);
    });

    res.json(genericResponse);
  } catch (error: any) {
    console.error('[Onboarding] Submission failed:', error.message);
    // Still the generic response — an internal error must not leak detail to an
    // unauthenticated caller either.
    res.json(genericResponse);
  }
});

// --- Public: confirm the contact's email (the token from sendOnboardingEmailConfirmation
// above) — the ONLY thing that flips emailVerifiedAt, which the approve route below
// requires be set. Unauthenticated by design, same as the request submission itself. ---
publicRouter.post('/onboarding-requests/confirm-email', async (req: any, res) => {
  const rawToken = String(req.body?.token || '').trim();
  if (!rawToken) {
    return res.status(400).json({ error: 'Missing confirmation token.' });
  }
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  try {
    const [request] = await db.select().from(schema.companyOnboardingRequests)
      .where(eq(schema.companyOnboardingRequests.emailConfirmTokenHash, tokenHash));

    if (!request || request.emailConfirmExpiresAt == null || new Date(request.emailConfirmExpiresAt) < new Date()) {
      return res.status(400).json({ error: 'This confirmation link is invalid or has expired. Ask the company to resubmit, or a super-admin to resend it.' });
    }
    // Already confirmed (a double-click, or the link opened twice) — idempotent success
    // rather than an error, matching this app's usual "already done" tolerance.
    if (request.emailVerifiedAt) {
      return res.json({ success: true, companyName: request.companyName });
    }

    // Deliberately NOT clearing emailConfirmTokenHash/emailConfirmExpiresAt here (unlike
    // passwordResetTokens' usedAt convention) — this row is looked up BY that hash, so
    // nulling it would make a second click of the same link (a real, expected case: the
    // user re-opens the email, or a slow double-tap) unfindable and fall through to the
    // "invalid or expired" branch above instead of the idempotent-success one right below
    // it. Once emailVerifiedAt is set, the hash can't achieve anything beyond that same
    // idempotent response anyway (the notification email above only ever fires once, on
    // the branch that sets emailVerifiedAt in the first place) — there's no replay risk
    // to guard against by clearing it.
    await db.update(schema.companyOnboardingRequests).set({
      emailVerifiedAt: new Date(),
    }).where(eq(schema.companyOnboardingRequests.id, request.id));

    // Only NOW does a super-admin hear about this request at all — see this route's own
    // file-header comment and sendOnboardingReceivedEmail's.
    if (isMailerConfigured()) {
      const admins = await db.select({ email: schema.users.email })
        .from(schema.users)
        .where(and(eq(schema.users.isSuperAdmin, true), isNotNull(schema.users.email)));
      const adminEmails = admins.map((a) => a.email).filter(Boolean) as string[];
      sendOnboardingReceivedEmail(adminEmails, request).catch((err: any) => {
        console.error('[Onboarding] Failed to send admin notification email:', err.message);
      });
    }

    res.json({ success: true, companyName: request.companyName });
  } catch (error: any) {
    console.error('[Onboarding] Email confirmation failed:', error.message);
    res.status(500).json({ error: 'Failed to confirm your email. Please try again.' });
  }
});

// --- Admin: list requests ---
adminRouter.get('/admin/onboarding-requests', async (req: any, res) => {
  try {
    if (!isSuperAdminUser(req.user)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const requests = await db.select().from(schema.companyOnboardingRequests)
      .orderBy(desc(schema.companyOnboardingRequests.createdAt));
    // Strip the hashed confirmation credential — same reasoning as never sending
    // users.password to the client (see src/db/apiState.ts's identical exclusion for the
    // /api/state-bundled copy of this same data).
    res.json(requests.map(({ emailConfirmTokenHash, emailConfirmExpiresAt, ...safe }) => safe));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Admin: resend the email confirmation link — for when the original expired (1 hour)
// before the contact clicked it. Regenerates a fresh token/expiry rather than reusing the
// old (now-expired) one, same as any other "resend" action in this app would. ---
adminRouter.post('/admin/onboarding-requests/:id/resend-confirmation', async (req: any, res) => {
  try {
    if (!isSuperAdminUser(req.user)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!isMailerConfigured()) {
      return res.status(503).json({ error: 'Email is not configured on this server.' });
    }
    const { id } = req.params;
    const [request] = await db.select().from(schema.companyOnboardingRequests)
      .where(eq(schema.companyOnboardingRequests.id, id));
    if (!request) {
      return res.status(404).json({ error: 'Onboarding request not found.' });
    }
    if (request.status !== 'Pending') {
      return res.status(400).json({ error: `This request has already been ${request.status.toLowerCase()}.` });
    }
    if (request.emailVerifiedAt) {
      return res.status(400).json({ error: 'This email is already confirmed.' });
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await db.update(schema.companyOnboardingRequests).set({
      emailConfirmTokenHash: tokenHash,
      emailConfirmExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }).where(eq(schema.companyOnboardingRequests.id, id));

    // The fresh token is already persisted regardless of what happens next — an SMTP
    // hiccup (rate limit, transient outage) must not leave this action looking like a
    // total no-op, but unlike every other mailer call in this file (fire-and-forget,
    // since those are side effects of a bigger action the admin didn't explicitly ask
    // for), THIS route's entire purpose is sending an email — so the caller genuinely
    // needs to know if it didn't go out, same reasoning as approve's own emailSent flag.
    const origin = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const confirmUrl = `${origin}/?confirmOnboardingToken=${rawToken}`;
    let emailSent = true;
    try {
      await sendOnboardingEmailConfirmation(request.contactEmail, confirmUrl, request.companyName);
    } catch (err: any) {
      console.error('[Onboarding] Failed to resend confirmation email:', err.message);
      emailSent = false;
    }

    res.json({ success: true, emailSent });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Admin: approve — atomically creates the company, its starter resources, the new
// user, and (in template mode) a cloned Role, all in one transaction. ---
adminRouter.post('/admin/onboarding-requests/:id/approve', async (req: any, res) => {
  try {
    if (!isSuperAdminUser(req.user)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const mode: 'admin' | 'template' = req.body?.mode === 'template' ? 'template' : 'admin';
    const roleTemplateId = req.body?.roleTemplateId;
    if (mode === 'template' && !roleTemplateId) {
      return res.status(400).json({ error: 'roleTemplateId is required when mode is "template".' });
    }

    let template: any = null;
    if (mode === 'template') {
      [template] = await db.select().from(schema.roleTemplates).where(eq(schema.roleTemplates.id, roleTemplateId));
      if (!template) {
        return res.status(404).json({ error: 'Role template not found.' });
      }
    }

    let newUserId: string;
    let newCompanyId: string;
    let contactEmail: string;
    let contactName: string;
    let companyName: string;

    await db.transaction(async (tx) => {
      // Lock the request row — without this, two admins clicking Approve at nearly the
      // same moment (or a double-click) could both pass the status check and provision
      // two companies for one request. Mirrors expenses.ts's /:id/pay lock exactly.
      const [request] = await tx.select().from(schema.companyOnboardingRequests)
        .where(eq(schema.companyOnboardingRequests.id, id)).for('update');
      if (!request) {
        const err: any = new Error('Onboarding request not found.');
        err.status = 404;
        throw err;
      }
      if (request.status !== 'Pending') {
        const err: any = new Error(`This request has already been ${request.status.toLowerCase()}.`);
        err.status = 400;
        throw err;
      }
      // Enforced here, not just hidden/disabled in the UI — see this file's own header
      // comment on why email confirmation exists at all. A direct API call must not be
      // able to bypass it just because the button was disabled client-side.
      if (!request.emailVerifiedAt) {
        const err: any = new Error('This request cannot be approved yet — the contact has not confirmed their email address.');
        err.status = 400;
        throw err;
      }

      companyName = request.companyName;
      contactEmail = request.contactEmail;
      contactName = request.contactName;
      newCompanyId = generateId();

      const brandTitle = request.companyName.substring(0, 10).toUpperCase() + ' PORTAL';
      await tx.insert(schema.companies).values({
        id: newCompanyId,
        name: request.companyName,
        address: request.companyAddress || '',
        phone: request.companyPhone || '',
        email: request.companyEmail,
        logoUrl: '',
        customHeader: '',
        customFooter: '',
        vatNumber: request.vatNumber,
        crNumber: request.crNumber,
        themeId: 'classic-executive',
        currency: request.currency || 'SAR',
        portalTitle: brandTitle,
        portalSubtitle: 'Shop ERP System',
        counters: { quotation: 1001, invoice: 1001, expense: 1001, voucher: 1001 },
        // Every self-signup company starts as an unconfirmed trial — a super-admin marks
        // it 'Registered' once the prospective customer actually completes registration
        // (payment, handled outside this system) via AdminSettings' Companies tab.
        registrationStatus: 'Trial',
      });

      await provisionStarterResources(tx, { companyId: newCompanyId, companyName: request.companyName });

      let roleIdForNewUser: string | null = null;
      if (mode === 'template' && template) {
        roleIdForNewUser = generateId();
        await tx.insert(schema.roles).values({
          id: roleIdForNewUser,
          companyId: newCompanyId,
          name: template.name,
          permissions: template.permissions,
        });
      }

      // Username is the contact's full email address (already lowercased at submission —
      // see the public route's `.toLowerCase()` on contactEmail), de-duplicated against
      // existing usernames — this app has no DB-level unique constraint on username (the
      // login route's own case-insensitive lookup is the only thing that cares), but a
      // collision would still make the new account ambiguous to log into.
      const baseUsername = request.contactEmail;
      let candidateUsername = baseUsername;
      let suffix = 0;
      // Bounded retry — a pathological number of collisions on one email is not a
      // real-world case worth an unbounded loop.
      while (suffix < 50) {
        const [existingUsername] = await tx.select({ id: schema.users.id }).from(schema.users)
          .where(eq(schema.users.username, candidateUsername));
        if (!existingUsername) break;
        suffix += 1;
        candidateUsername = `${baseUsername}+${suffix}`;
      }

      newUserId = generateId();
      // A long random password nobody will ever use — the new user's only path to access
      // is the emailed set-password link below, never a plaintext password.
      const unusablePassword = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      await tx.insert(schema.users).values({
        id: newUserId,
        username: candidateUsername,
        email: request.contactEmail,
        password: unusablePassword,
        role: mode === 'admin' ? 'admin' : 'user',
        companyId: newCompanyId,
        isSuperAdmin: false,
        isActive: true,
        uiLanguage: 'en',
      });

      if (roleIdForNewUser) {
        await tx.insert(schema.userRoles).values({ userId: newUserId, roleId: roleIdForNewUser });
      }

      await tx.update(schema.companyOnboardingRequests).set({
        status: 'Approved',
        reviewedById: req.user.id,
        reviewedAt: new Date(),
        createdCompanyId: newCompanyId,
      }).where(eq(schema.companyOnboardingRequests.id, id));
    });

    // Outside the transaction, matching forgot-password's own token-issuance pattern —
    // this is a separate, best-effort concern from the atomic provisioning above.
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await db.insert(schema.passwordResetTokens).values({
      id: generateId(),
      userId: newUserId!,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const origin = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const resetUrl = `${origin}/?resetToken=${rawToken}`;

    let emailSent = false;
    if (isMailerConfigured()) {
      try {
        await sendOnboardingApprovedEmail(contactEmail!, resetUrl, companyName!);
        emailSent = true;
      } catch (err: any) {
        console.error('[Onboarding] Failed to send approval email:', err.message);
      }
    }

    res.json({
      success: true,
      companyId: newCompanyId!,
      userId: newUserId!,
      emailSent,
      // Only returned when mail isn't configured (e.g. local dev without SMTP) — lets a
      // super-admin manually hand the new user their set-password link. Never exposed
      // when the email actually went out.
      resetUrl: emailSent ? undefined : resetUrl,
    });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// --- Admin: reject ---
adminRouter.post('/admin/onboarding-requests/:id/reject', async (req: any, res) => {
  try {
    if (!isSuperAdminUser(req.user)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const reason = cap(req.body?.reason, 1000) || null;

    let contactEmail: string | undefined;
    let companyName: string | undefined;

    await db.transaction(async (tx) => {
      const [request] = await tx.select().from(schema.companyOnboardingRequests)
        .where(eq(schema.companyOnboardingRequests.id, id)).for('update');
      if (!request) {
        const err: any = new Error('Onboarding request not found.');
        err.status = 404;
        throw err;
      }
      if (request.status !== 'Pending') {
        const err: any = new Error(`This request has already been ${request.status.toLowerCase()}.`);
        err.status = 400;
        throw err;
      }
      contactEmail = request.contactEmail;
      companyName = request.companyName;

      await tx.update(schema.companyOnboardingRequests).set({
        status: 'Rejected',
        reviewedById: req.user.id,
        reviewedAt: new Date(),
        rejectionReason: reason,
      }).where(eq(schema.companyOnboardingRequests.id, id));
    });

    if (isMailerConfigured() && contactEmail && companyName) {
      sendOnboardingRejectedEmail(contactEmail, companyName, reason || undefined).catch((err) => {
        console.error('[Onboarding] Failed to send rejection email:', err.message);
      });
    }

    res.json({ success: true });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});
