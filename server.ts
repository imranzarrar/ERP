// Deliberately not the default `.env` filename — see .gitignore's comment on
// `app.secrets` for why (avoids collision with a hosting platform's own .env-specific
// tooling). Resolved relative to the process's working directory, matching dotenv's own
// default `.env` lookup behavior exactly, just against a different filename.
import dotenv from 'dotenv';
dotenv.config({ path: 'app.secrets', quiet: true });
import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import bcrypt from "bcrypt";
import session from "express-session";
import pgSession from "connect-pg-simple";
const PgSession = pgSession(session);
import { eq, sql, and, or, desc, lt, ilike, inArray } from 'drizzle-orm';
import { db, pool } from './src/db/index.js';
import * as schema from './src/db/schema.js';
import { mergeRolePermissions, normalizePermissions } from './src/types.js';
import { isSuperAdminUser } from './server/lib/authz.js';
import { generateId } from './src/id.js';
import crypto from 'crypto';
import { recordAuditLog } from './server/lib/audit.js';
import { isMailerConfigured, sendPasswordResetEmail } from './server/lib/mailer.js';
import masterEntitiesRouter from './server/routes/masterEntities.js';
import usersRouter from './server/routes/users.js';
import rolesRouter from './server/routes/roles.js';
import transactionsRouter from './server/routes/transactions.js';
import expensesRouter from './server/routes/expenses.js';
import posRouter from './server/routes/pos.js';
import zatcaRouter from './server/routes/zatca.js';
import inventoryRouter from './server/routes/inventory.js';
import settingsResourcesRouter from './server/routes/settingsResources.js';
import branchesRouter from './server/routes/branches.js';
import taxReturnsRouter from './server/routes/taxReturns.js';
import employeesRouter from './server/routes/employees.js';

// A user's effective permissions come from every Role assigned to them (see the
// `userRoles` junction table in src/db/schema.ts), not a per-user column — this is the
// single point where that resolution happens for server-side checks. Every downstream
// `normalizePermissions(req.user.permissions, ...)` call is unaffected by this
// indirection since it still just reads a plain permissions-shaped object off the user.
async function resolveUserPermissions(userId: string): Promise<any> {
  const assignedRoles = await db.select({ permissions: schema.roles.permissions })
    .from(schema.userRoles)
    .innerJoin(schema.roles, eq(schema.userRoles.roleId, schema.roles.id))
    .where(eq(schema.userRoles.userId, userId));
  if (!assignedRoles.length) return null;
  return mergeRolePermissions(assignedRoles.map(r => r.permissions));
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  app.set('trust proxy', 1);

  // --- Resilient Session Store Fallback ---
  // Falls back from Postgres to in-memory sessions on error, same as before — but the
  // fallback now self-heals instead of being permanent. The original version latched
  // `useBackup = true` for the lifetime of the process on the very first transient error
  // (a momentary network blip, a brief pool exhaustion during a deploy): every session
  // afterward silently stopped persisting to Postgres, with no path back, for as long as
  // that process kept running — invisible in normal operation, and fatal to horizontal
  // scaling specifically (a second app instance shares nothing with the first's
  // in-memory sessions, so a user's next request landing on a different instance sees
  // them as logged out). Real production traffic can and will produce a transient DB
  // hiccup at some point; the store needs to recover from one automatically, not require
  // a process restart to notice it's been degraded.
  class ResilientSessionStore extends session.Store {
    private pgStore: any;
    private memStore: any;
    private useBackup: boolean = false;
    private lastFailureAt: number = 0;
    // After this many ms since the last failure, the next operation gets a real retry
    // against Postgres instead of assuming it's still down. Short enough to recover
    // quickly from a real blip; long enough not to hammer a genuinely-down DB with a
    // retry on every single request in the meantime.
    private readonly RECOVERY_COOLDOWN_MS = 10000;

    constructor() {
      super();
      this.memStore = new session.MemoryStore();
      try {
        this.pgStore = new PgSession({
          pool: pool as any,
          tableName: 'user_sessions'
        });

        this.pgStore.on('error', (err: any) => {
          console.warn("[Session] PgSession store error (switching to memory fallback):", err.message);
          this.markFailure();
        });
      } catch (e: any) {
        console.warn("[Session] Failed to initialize PgSession, using MemoryStore:", e.message);
        // pgStore was never constructed here — nothing to retry, so this one case
        // (unlike every markFailure() below) is a genuinely permanent fallback.
        this.useBackup = true;
      }
    }

    private markFailure() {
      this.useBackup = true;
      this.lastFailureAt = Date.now();
    }

    private markRecovered() {
      if (this.useBackup) {
        console.log("[Session] PgSession store recovered — switching back from memory fallback.");
      }
      this.useBackup = false;
    }

    // Note on the tradeoff this implies: a session created or renewed in MemoryStore
    // during a fallback window won't exist in pgStore once recovery flips back — that
    // user's session effectively ends when the store recovers. That's a real limitation
    // of any dual-store fallback without a synchronization step between the two, but it
    // bounds the blast radius to sessions active during the outage window instead of
    // every session for the rest of the process's life, which is what made the original
    // permanent-latch version unacceptable for a scaled deployment.
    private shouldUseBackup(): boolean {
      if (!this.pgStore) return true;
      if (!this.useBackup) return false;
      return (Date.now() - this.lastFailureAt) < this.RECOVERY_COOLDOWN_MS;
    }

    get(sid: string, callback: any) {
      if (this.shouldUseBackup()) {
        return this.memStore.get(sid, callback);
      }
      this.pgStore.get(sid, (err: any, session: any) => {
        if (err) {
          console.warn("[Session] PgSession.get failed, falling back to MemoryStore:", err.message);
          this.markFailure();
          return this.memStore.get(sid, callback);
        }
        this.markRecovered();
        callback(null, session);
      });
    }

    set(sid: string, session: any, callback: any) {
      if (this.shouldUseBackup()) {
        return this.memStore.set(sid, session, callback);
      }
      this.pgStore.set(sid, session, (err: any) => {
        if (err) {
          console.warn("[Session] PgSession.set failed, falling back to MemoryStore:", err.message);
          this.markFailure();
          return this.memStore.set(sid, session, callback);
        }
        this.markRecovered();
        if (callback) callback(null);
      });
    }

    destroy(sid: string, callback: any) {
      if (this.shouldUseBackup()) {
        return this.memStore.destroy(sid, callback);
      }
      this.pgStore.destroy(sid, (err: any) => {
        if (err) {
          console.warn("[Session] PgSession.destroy failed, falling back to MemoryStore:", err.message);
          this.markFailure();
          return this.memStore.destroy(sid, callback);
        }
        this.markRecovered();
        if (callback) callback(null);
      });
    }
  }

  if (!process.env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET environment variable must be set — refusing to start with a default/guessable session secret.');
  }

  app.use(session({
    store: new ResilientSessionStore(),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: true,
      sameSite: 'none'
    }
  }));

  // --- Auth Middleware ---
  // Identity may only come from a verified session: either the cookie-backed
  // `req.session.userId`, or a DB-backed session-id lookup (for non-cookie clients) that
  // checks the session row's expiry. A client-supplied user id (header/query/bearer) is
  // NEVER trusted as identity on its own — that was a full authentication bypass.
  const isAuthenticated = async (req: any, res: any, next: any) => {
    let userId = req.session?.userId;

    const headerSessionId = req.headers['x-session-id'] || req.headers['X-Session-ID'];
    const querySessionId = req.query.sessionId || req.query.session_id;
    const resolvedSessionId = headerSessionId || querySessionId;

    // Which underlying user_sessions row this request's identity actually comes from -
    // req.sessionID for the normal cookie path, or the raw x-session-id/query value for
    // the non-cookie path. A route that needs to persist something into "this session"
    // (e.g. POST /api/switch-company below) must write to *this* row specifically -
    // req.session here is a fresh, disconnected session object on the non-cookie path
    // (express-session always allocates one per request regardless of whether a valid
    // cookie was presented), so writes to req.session alone silently vanish for any
    // caller using x-session-id, which never sees them on its next request.
    req.activeSessionId = req.sessionID;

    if (!userId && resolvedSessionId) {
      try {
        const [sessionRow] = await db.select()
          .from(schema.user_sessions)
          .where(eq(schema.user_sessions.sid, String(resolvedSessionId)));

        if (sessionRow && sessionRow.sess && sessionRow.expire > new Date()) {
          const sessionData = sessionRow.sess as any;
          if (sessionData && sessionData.userId) {
            userId = sessionData.userId;
            req.activeSessionId = String(resolvedSessionId);
            if (req.session) {
              req.session.userId = sessionData.userId;
              req.session.companyId = sessionData.companyId;
            }
          }
        }
      } catch (err) {
        console.error("[Auth] Database session retrieval failed:", err);
      }
    }

    if (userId) {
      let user;
      try {
        user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).then(r => r[0]);
      } catch (err: any) {
        console.error("[Database] Auth middleware user query failed:", err.message);
      }

      if (user && user.isDeleted !== 1) {
        req.user = user;
        try {
          req.user.permissions = await resolveUserPermissions(user.id);
        } catch (err: any) {
          console.error("[Auth] Role permission resolution failed:", err.message);
          req.user.permissions = null;
        }

        // Determine target company. Resolution order: an explicit per-request override
        // (query/body/header - used when a request is deliberately acting on a specific
        // company right now), then the *persisted* selection in the session (set at
        // login and updated by POST /api/switch-company below - this is what "the
        // currently selected company" actually means across the portal), then finally
        // the user's own home company as the last-resort default. Previously this last
        // fallback ran whenever no per-request param was passed - which is most
        // requests, since only a handful of call sites ever bothered to pass one - so a
        // super-admin's company selection was silently discarded on nearly every request
        // that didn't explicitly repeat it, always reverting to their own home company.
        let companyId = req.query.companyId || req.body.companyId || req.headers['x-company-id'];

        if (companyId) {
          if (user.role === 'super-admin' || user.isSuperAdmin === true) {
            req.targetCompanyId = companyId;
          } else if (user.companyId && companyId !== user.companyId) {
            req.targetCompanyId = user.companyId;
          } else {
            req.targetCompanyId = companyId;
          }
        } else if (req.session?.companyId) {
          req.targetCompanyId = req.session.companyId;
        } else {
          req.targetCompanyId = user.companyId;
        }

        // Branch (physical-location) scoping. null means "no ceiling" — sees/can act on
        // every branch in the company (admin/super-admin/the viewAllBranches permission
        // leaf); otherwise the exact set from userBranches, which every document-creation
        // route validates an incoming branchId against, and which read-path scoping will
        // filter by as that rolls out further. Deliberately fails CLOSED on any lookup
        // error for a non-privileged user (empty array = allowed to act on nothing) rather
        // than falling back to unrestricted — a thrown query here must never silently
        // widen what a restricted user can see.
        try {
          const normalizedPerms = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
          const canViewAllBranches = isSuperAdminUser(req.user) || user.role === 'admin' || normalizedPerms?.branches?.viewAllBranches?.enabled === true;
          if (canViewAllBranches) {
            req.allowedBranchIds = null;
            req.primaryBranchId = null;
          } else {
            const branchRows = await db.select({ branchId: schema.userBranches.branchId, isPrimary: schema.userBranches.isPrimary })
              .from(schema.userBranches)
              .where(eq(schema.userBranches.userId, user.id));
            // Branch restriction is only meaningful once the company has actually adopted
            // branches at all — the exact same "optional until adopted" rule this app
            // already applies everywhere else (see resolveDocumentBranchId's own comment,
            // and the mandatory-branch-once-one-exists checks in warehouses/users routes).
            // Without this, an ordinary permission-scoped user who simply has no row in
            // userBranches (the default for every user in a company that has never
            // created a branch) would be resolved to an EMPTY allowedBranchIds array —
            // and since every one of that company's documents carries branchId: null,
            // branchAccessOk's `allowedBranchIds.includes(null)` is always false, silently
            // locking that user out of acting on ANY document at all. Confirmed live: a
            // permission-scoped role with no branch assignment could no longer cancel its
            // own quotation or approve a purchase requisition the moment branch-ownership
            // checks were added to those routes, in a company with zero branches. Only
            // once the company has ≥1 real branch does "you have zero rows in
            // userBranches" mean anything restrictive — before that point there is
            // nothing to be restricted FROM.
            const [anyBranch] = await db.select({ id: schema.branches.id }).from(schema.branches)
              .where(eq(schema.branches.companyId, req.targetCompanyId));
            if (!anyBranch) {
              req.allowedBranchIds = null;
              req.primaryBranchId = null;
            } else {
              req.allowedBranchIds = branchRows.map(r => r.branchId);
              req.primaryBranchId = branchRows.find(r => r.isPrimary)?.branchId || branchRows[0]?.branchId || null;
            }
          }
        } catch (err: any) {
          console.error("[Auth] Branch resolution failed, failing closed:", err.message);
          req.allowedBranchIds = [];
          req.primaryBranchId = null;
        }

        return next();
      }
      console.log("[Auth] User not found in DB or is deleted for userId:", userId);
    } else {
      console.log("[Auth] No session found. SessionID:", req.sessionID);
    }
    res.status(401).json({ error: 'Unauthorized' });
  };

  const isAdmin = async (req: any, res: any, next: any) => {
    if (req.user && (req.user.role === 'admin' || req.user.role === 'super-admin' || req.user.isSuperAdmin === true)) {
      return next();
    }
    res.status(403).json({ error: 'Forbidden' });
  };

  // --- Login Endpoint ---
  app.post("/api/login", async (req: any, res: any) => {
    const { username, password } = req.body;
    console.log("Login attempt for:", username);
    
    // Normalize username: trim and convert to lowercase
    let cleanUsername = String(username || '').trim().toLowerCase();
    
    // Friendly mapping for owner's email / alternative inputs
    if (cleanUsername === 'imranzarrar@gmail.com' || cleanUsername === 'imranzarrar') {
      cleanUsername = 'imranz';
    }
    
    // Perform case-insensitive search in Postgres
    let user;
    try {
      user = await db.select()
        .from(schema.users)
        .where(sql`LOWER(${schema.users.username}) = ${cleanUsername}`)
        .then(r => r[0]);
    } catch (err: any) {
      console.error("[Database] Login query failed:", err.message);
      return res.status(500).json({ error: 'Database query failed' });
    }
    
    if (user && user.isDeleted === 1) {
      return res.status(401).json({ error: 'User account has been deleted' });
    }
    
    // Only a bcrypt-verified match is accepted. A plaintext-equality fallback and an
    // auto-granted default password for null-password accounts were both removed —
    // both were standing authentication backdoors.
    let isPasswordCorrect = false;
    if (user && user.password && password) {
      try {
        isPasswordCorrect = await bcrypt.compare(password, user.password);
      } catch (e) {
        console.error("Bcrypt compare error:", e);
        isPasswordCorrect = false;
      }
    }

    if (isPasswordCorrect && user) {
      console.log("Found user, setting session:", user.id, "SessionID:", req.sessionID);
      req.session.userId = user.id;
      req.session.companyId = user.companyId;
      console.log("Session object before save:", req.session);
      
      // Log successful login
      recordAuditLog(
        { user, targetCompanyId: user.companyId, ip: req.ip, headers: req.headers, socket: req.socket },
        'LOGIN',
        'user',
        user.id,
        { username: user.username, status: 'success' }
      );

      req.session.save(async (err) => {
        if (err) {
          console.error("Session save error:", err);
          return res.status(500).json({ error: 'Session save failed' });
        }
        console.log("Session saved successfully, SessionID:", req.sessionID);

        // Exclude the password hash from the client response
        const safeUser: any = { ...user };
        delete safeUser.password;
        safeUser.permissions = await resolveUserPermissions(user.id).catch(() => null);
        res.json({ message: 'Logged in', user: safeUser, sessionId: req.sessionID });
      });
    } else {
      console.log("Login failed for:", username);
      // Log failed login
      recordAuditLog(
        { ip: req.ip, headers: req.headers, socket: req.socket },
        'LOGIN_FAILED',
        'user',
        null,
        { username, status: 'failed', reason: user ? 'invalid_password' : 'user_not_found' }
      );
      res.status(401).json({ error: 'Invalid credentials' });
    }
  });

  app.post("/api/logout", async (req: any, res: any) => {
    const sid = req.sessionID;
    res.clearCookie("connect.sid");
    if (sid) {
      try {
        await db.delete(schema.user_sessions).where(eq(schema.user_sessions.sid, sid));
      } catch (e) {
        // Ignore DB session deletion error
      }
    }
    if (req.session) {
      req.session.destroy((err: any) => {
        res.json({ success: true, message: "Logged out successfully" });
      });
    } else {
      res.json({ success: true, message: "Logged out" });
    }
  });

  // --- Forgot Password: request a reset link ---
  // Always responds with the same generic message regardless of whether the username
  // exists, has an email on file, or SMTP is even configured for that account-existence
  // question specifically — this is the one place in the app deliberately designed to
  // never confirm or deny that a given username exists (classic account-enumeration
  // guard). The one exception is when SMTP itself isn't configured at all: that's a
  // global server-configuration fact, not a per-account secret, so it's surfaced plainly
  // (mainly useful for admins/testers working on a fresh checkout before .env is filled in).
  app.post("/api/auth/forgot-password", async (req: any, res: any) => {
    if (!isMailerConfigured()) {
      return res.status(503).json({ error: 'Password reset is not configured on this server yet (no SMTP credentials set in .env). Contact your administrator.' });
    }

    const cleanUsername = String(req.body?.username || '').trim().toLowerCase();
    const genericResponse = { message: 'If that account exists and has an email on file, a password reset link has been sent to it.' };
    if (!cleanUsername) {
      return res.json(genericResponse);
    }

    try {
      const user = await db.select()
        .from(schema.users)
        .where(sql`LOWER(${schema.users.username}) = ${cleanUsername}`)
        .then(r => r[0]);

      if (user && user.isDeleted !== 1 && user.isActive !== false && user.email) {
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        await db.insert(schema.passwordResetTokens).values({
          id: generateId(),
          userId: user.id,
          tokenHash,
          expiresAt,
        });

        const origin = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
        const resetUrl = `${origin}/?resetToken=${rawToken}`;

        sendPasswordResetEmail(user.email, resetUrl, user.username).catch((err) => {
          console.error('[Mailer] Failed to send password reset email:', err.message);
        });

        recordAuditLog(
          { user, targetCompanyId: user.companyId, ip: req.ip, headers: req.headers, socket: req.socket },
          'PASSWORD_RESET_REQUESTED',
          'user',
          user.id,
          { username: user.username }
        );
      }
    } catch (err: any) {
      console.error('[Auth] Forgot-password lookup failed:', err.message);
      // Still fall through to the generic response — a DB hiccup here shouldn't leak
      // anything different to the caller than "account not found" would.
    }

    res.json(genericResponse);
  });

  // --- Forgot Password: consume the token, set a new password ---
  app.post("/api/auth/reset-password", async (req: any, res: any) => {
    const rawToken = String(req.body?.token || '').trim();
    const newPassword = String(req.body?.newPassword || '');

    if (!rawToken) {
      return res.status(400).json({ error: 'Missing reset token.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    try {
      const tokenRow = await db.select()
        .from(schema.passwordResetTokens)
        .where(eq(schema.passwordResetTokens.tokenHash, tokenHash))
        .then(r => r[0]);

      if (!tokenRow || tokenRow.usedAt || new Date(tokenRow.expiresAt) < new Date()) {
        return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
      }

      const hashedPassword = await bcrypt.hash(newPassword, 10);
      await db.update(schema.users).set({ password: hashedPassword }).where(eq(schema.users.id, tokenRow.userId));
      await db.update(schema.passwordResetTokens).set({ usedAt: new Date() }).where(eq(schema.passwordResetTokens.id, tokenRow.id));

      const user = await db.select().from(schema.users).where(eq(schema.users.id, tokenRow.userId)).then(r => r[0]);
      if (user) {
        recordAuditLog(
          { user, targetCompanyId: user.companyId, ip: req.ip, headers: req.headers, socket: req.socket },
          'PASSWORD_RESET_COMPLETED',
          'user',
          user.id,
          { username: user.username }
        );
      }

      res.json({ message: 'Password updated. You can now log in with your new password.' });
    } catch (err: any) {
      console.error('[Auth] Reset-password failed:', err.message);
      res.status(500).json({ error: 'Failed to reset password. Please try again.' });
    }
  });

  // API Routes (Public)
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Protect remaining routes
  app.use('/api', isAuthenticated);

  // Persists which company a super-admin is currently viewing into the session itself,
  // so it's automatically honored by every subsequent request's isAuthenticated
  // resolution (req.session.companyId) without each individual fetch call needing to
  // remember to repeat it as a query param. Only a super-admin may switch companies -
  // a company-scoped admin/user has exactly one company and no UI ever offers this.
  app.post('/api/switch-company', async (req: any, res: any) => {
    const isSuper = req.user?.isSuperAdmin === true || req.user?.role === 'super-admin';
    if (!isSuper) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { companyId } = req.body;
    if (!companyId || typeof companyId !== 'string') {
      return res.status(400).json({ error: 'companyId is required' });
    }
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    req.session.companyId = companyId;

    // Persist directly into the actual stored session row for req.activeSessionId
    // (set by isAuthenticated) rather than relying solely on req.session.save() - on the
    // x-session-id path req.session is a fresh, disconnected object express-session
    // allocates per-request, and .save() on it would silently write to a *different*
    // row than the one subsequent x-session-id requests actually look up.
    try {
      const [existingRow] = await db.select().from(schema.user_sessions)
        .where(eq(schema.user_sessions.sid, req.activeSessionId));
      if (existingRow) {
        const mergedSess = { ...(existingRow.sess as any), companyId };
        await db.update(schema.user_sessions)
          .set({ sess: mergedSess })
          .where(eq(schema.user_sessions.sid, req.activeSessionId));
      }
    } catch (err) {
      console.error('[switch-company] Direct session row update failed:', err);
    }

    req.session.save((err: any) => {
      if (err) {
        console.error('[switch-company] Session save error:', err);
        return res.status(500).json({ error: 'Failed to persist company selection' });
      }
      res.json({ success: true, companyId });
    });
  });

  // --- Auto-Audit Interceptor Middleware ---
  app.use(async (req: any, res: any, next: any) => {
    const method = req.method;
    const path = req.path;

    if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
      return next();
    }

    // Skip audit logs operations and general health checks
    if (path.includes('/api/audit-logs') || path.includes('/api/health') || path === '/api/login' || path === '/api/logout') {
      return next();
    }

    const originalJson = res.json;
    res.json = function (body: any) {
      res.json = originalJson;

      if (res.statusCode >= 200 && res.statusCode < 300) {
        try {
          let action = '';
          let entityType = '';
          let entityId = req.body?.id || null;
          let details: any = {};

          const segments = path.split('/').filter(Boolean);
          const cleanSegments = segments[0] === 'api' ? segments.slice(1) : segments;
          const baseEntity = cleanSegments[0];
          const subEntity = cleanSegments[1];

          if (baseEntity === 'customers') {
            entityType = 'customer';
            if (method === 'POST') {
              action = req.body?.id ? 'UPDATE_CUSTOMER' : 'CREATE_CUSTOMER';
              details = { name: req.body?.name, email: req.body?.email };
            } else if (method === 'DELETE') {
              entityId = cleanSegments[1] || null;
              action = 'DELETE_CUSTOMER';
              details = { id: entityId };
            }
          } else if (baseEntity === 'vendors') {
            entityType = 'vendor';
            if (method === 'POST') {
              action = req.body?.id ? 'UPDATE_VENDOR' : 'CREATE_VENDOR';
              details = { name: req.body?.name, email: req.body?.email };
            } else if (method === 'DELETE') {
              entityId = cleanSegments[1] || null;
              action = 'DELETE_VENDOR';
              details = { id: entityId };
            }
          } else if (baseEntity === 'products') {
            entityType = 'product';
            if (method === 'POST') {
              action = req.body?.id ? 'UPDATE_PRODUCT' : 'CREATE_PRODUCT';
              details = { name: req.body?.name, price: req.body?.sellingPrice };
            } else if (method === 'DELETE') {
              entityId = cleanSegments[1] || null;
              action = 'DELETE_PRODUCT';
              details = { id: entityId };
            }
          } else if (baseEntity === 'users') {
            entityType = 'user';
            if (method === 'POST') {
              action = req.body?.id ? 'UPDATE_USER' : 'CREATE_USER';
              details = { username: req.body?.username, role: req.body?.role };
            } else if (method === 'DELETE') {
              entityId = cleanSegments[1] || null;
              action = 'DELETE_USER';
              details = { id: entityId };
            }
          } else if (baseEntity === 'banks') {
            entityType = 'bank';
            if (method === 'POST') {
              action = 'SAVE_BANK_ACCOUNT';
              details = { bankName: req.body?.bankName, accountNumber: req.body?.accountNumber };
            }
          } else if (baseEntity === 'tax-slabs') {
            entityType = 'tax_slab';
            if (method === 'POST') {
              action = 'SAVE_TAX_SLAB';
              details = { name: req.body?.name, rate: req.body?.rate };
            }
          } else if (baseEntity === 'companies') {
            entityType = 'company';
            if (method === 'POST') {
              action = 'SAVE_COMPANY_SETTINGS';
              details = { name: req.body?.name };
            }
          } else if (baseEntity === 'transactions') {
            if (subEntity === 'quotations') {
              entityType = 'quotation';
              if (method === 'POST') {
                action = req.body?.id ? 'UPDATE_QUOTATION' : 'CREATE_QUOTATION';
                details = { quotationNumber: req.body?.quotationNumber, date: req.body?.date, customerId: req.body?.customerId, total: req.body?.totalAmount };
              } else if (method === 'DELETE') {
                entityId = cleanSegments[2] || null;
                action = 'DELETE_QUOTATION';
                details = { id: entityId };
              }
            } else if (subEntity === 'invoices') {
              entityType = 'invoice';
              if (method === 'POST') {
                action = req.body?.id ? 'UPDATE_INVOICE' : 'CREATE_INVOICE';
                details = { invoiceNumber: req.body?.invoiceNumber, date: req.body?.date, customerId: req.body?.customerId, total: req.body?.totalAmount, paymentStatus: req.body?.paymentStatus };
              } else if (method === 'DELETE') {
                entityId = cleanSegments[2] || null;
                action = 'DELETE_INVOICE';
                details = { id: entityId };
              }
            } else if (subEntity === 'vouchers') {
              entityType = 'voucher';
              if (method === 'POST') {
                action = 'SAVE_VOUCHER';
                details = { voucherNumber: req.body?.voucherNumber, type: req.body?.type, amount: req.body?.amount };
              }
            } else if (subEntity === 'investors') {
              entityType = 'investor';
              if (method === 'POST') {
                action = 'SAVE_INVESTOR';
                details = { name: req.body?.name, type: req.body?.type };
              }
            } else if (subEntity === 'months') {
              entityType = 'fiscal_month';
              if (method === 'POST') {
                action = req.body?.action === 'open' ? 'OPEN_FISCAL_MONTH' : 'CLOSE_FISCAL_MONTH';
                entityId = req.body?.monthId || null;
                details = { monthId: req.body?.monthId };
              }
            }
          } else if (baseEntity === 'expenses') {
            entityType = 'expense';
            if (method === 'POST') {
              action = req.body?.id ? 'UPDATE_EXPENSE' : 'CREATE_EXPENSE';
              details = { expenseNumber: req.body?.expenseNumber, amount: req.body?.amount, vendorId: req.body?.vendorId };
            } else if (method === 'DELETE') {
              entityId = cleanSegments[1] || null;
              action = 'DELETE_EXPENSE';
              details = { id: entityId };
            }
          } else if (baseEntity === 'pos') {
            if (subEntity === 'shifts') {
              entityType = 'pos_shift';
              if (method === 'POST') {
                if (path.endsWith('/open')) {
                  action = 'OPEN_POS_SHIFT';
                  details = { openingCash: req.body?.openingCash };
                } else if (path.endsWith('/close')) {
                  action = 'CLOSE_POS_SHIFT';
                  details = { closingCash: req.body?.closingCash };
                }
              }
            } else if (subEntity === 'held') {
              entityType = 'pos_held_invoice';
              if (method === 'POST') {
                action = 'HOLD_POS_INVOICE';
                details = { reference: req.body?.reference };
              }
            } else if (subEntity === 'sale') {
              entityType = 'pos_sale';
              if (method === 'POST') {
                action = 'SUBMIT_POS_SALE';
                details = { invoiceNumber: req.body?.invoiceNumber, total: req.body?.total };
              }
            }
          }

          if (!action) {
            action = `${method}_${baseEntity?.toUpperCase() || 'UNKNOWN'}`;
            entityType = baseEntity || 'system';
            details = { url: req.originalUrl };
          }

          recordAuditLog(req, action, entityType, entityId, details);
        } catch (err) {
          console.error('[Audit Interceptor Error]', err);
        }
      }

      return originalJson.call(this, body);
    };

    next();
  });

  // Protected Routers
  app.use('/api', masterEntitiesRouter);
  app.use('/api', branchesRouter);
  app.use('/api', taxReturnsRouter);
  app.use('/api', employeesRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/roles', rolesRouter);
  app.use('/api/transactions', transactionsRouter);
  app.use('/api/expenses', expensesRouter);
  app.use('/api/pos', posRouter);
  app.use('/api/zatca', zatcaRouter);
  app.use('/api/inventory', inventoryRouter);
  app.use('/api', settingsResourcesRouter);

  // Protected Routes
  app.get("/api/companies", async (req: any, res: any) => {
    try {
      const isSuper = req.user?.isSuperAdmin === true || req.user?.role === 'super-admin';
      const companiesList = isSuper
        ? await db.select().from(schema.companies)
        : await db.select().from(schema.companies).where(eq(schema.companies.id, req.targetCompanyId));

      // ZATCA secrets live in zatcaEnvironmentConfigs (never selected here), not on
      // companies itself — nothing to strip anymore, but this response intentionally
      // stays scoped to companies only, so a general "list companies" call still can't
      // pull ZATCA credential rows in.
      res.json(companiesList);
    } catch (error: any) {
      console.error("Failed to fetch companies:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // --- Audit Logs ---
  app.get("/api/audit-logs", isAdmin, async (req: any, res: any) => {
    try {
      let whereClause: any[] = [];
      const queryCompanyId = req.query.companyId;

      if (req.user?.role !== 'super-admin' && req.user?.isSuperAdmin !== true) {
        // Standard admin can only see their own company's audit logs
        whereClause.push(eq(schema.auditLogs.companyId, req.targetCompanyId || ''));
      } else if (queryCompanyId && queryCompanyId !== 'all') {
        whereClause.push(eq(schema.auditLogs.companyId, queryCompanyId));
      }

      if (req.query.action) {
        whereClause.push(eq(schema.auditLogs.action, String(req.query.action)));
      }
      if (req.query.entityType) {
        whereClause.push(eq(schema.auditLogs.entityType, String(req.query.entityType)));
      }
      if (req.query.search) {
        const searchPattern = `%${String(req.query.search).toLowerCase()}%`;
        whereClause.push(or(
          ilike(schema.auditLogs.username, searchPattern),
          ilike(schema.auditLogs.action, searchPattern),
          ilike(schema.auditLogs.entityType, searchPattern),
          ilike(schema.auditLogs.details, searchPattern)
        ));
      }

      let baseQuery = db.select().from(schema.auditLogs);
      let finalQuery = whereClause.length > 0 ? baseQuery.where(and(...whereClause)) : baseQuery;

      const logs = await finalQuery
        .orderBy(desc(schema.auditLogs.createdAt))
        .limit(200);

      res.json(logs);
    } catch (error: any) {
      console.error("Failed to fetch audit logs:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/audit-logs/purge", isAdmin, async (req: any, res: any) => {
    try {
      const isSuper = req.user?.isSuperAdmin === true || req.user?.role === 'super-admin';
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

      // A plain company admin may only purge their own company's history; only a
      // super-admin may purge across every tenant.
      const purgeCondition = isSuper
        ? lt(schema.auditLogs.createdAt, oneYearAgo)
        : and(lt(schema.auditLogs.createdAt, oneYearAgo), eq(schema.auditLogs.companyId, req.targetCompanyId || ''));

      await db.delete(schema.auditLogs).where(purgeCondition);

      // Record the purge action itself in the logs
      await recordAuditLog(req, 'PURGE_AUDIT_LOGS', 'audit_logs', null, {
        message: 'Manually triggered audit log purge. Retained last 1 year of logs.',
        deletedBefore: oneYearAgo.toISOString(),
      });

      res.json({ success: true, message: 'Audit logs older than 1 year purged successfully.' });
    } catch (error: any) {
      console.error("Purge audit logs error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/migrate", async (req: any, res) => {
    try {
      const data = req.body;
      const { migrateDataToPostgres } = await import('./src/db/migrateData.js');
      const result = await migrateDataToPostgres(data, { user: req.user, targetCompanyId: req.targetCompanyId });
      res.json(result || { success: true });
    } catch (error: any) {
      console.error("Migration endpoint error:", error);
      res.status(error.status || 500).json({ error: error.message });
    }
  });

  app.get("/api/export-postgres", isAdmin, async (req, res) => {
    try {
      const { db } = await import('./src/db/index.js');
      const schema = await import('./src/db/schema.js');
      const { getTableColumns, getTableName } = await import('drizzle-orm');

      const tables = [
        schema.companies,
        schema.users,
        schema.documentTemplates,
        schema.taxSlabs,
        schema.productsServices,
        schema.customers,
        schema.vendors,
        schema.bankAccounts,
        schema.fiscalMonths,
        schema.quotations,
        schema.quotationItems,
        schema.invoices,
        schema.invoiceItems,
        schema.expenses,
        schema.expenseItems,
        schema.recurringExpenseTemplates,
        schema.recurringPostings,
        schema.vouchers,
        schema.investors,
        schema.posShifts,
        schema.posHeldInvoices,
        schema.translations,
        schema.warehouses,
        schema.glGroupMappings,
        schema.purchaseRequisitions,
        schema.purchaseRequisitionItems,
        schema.purchaseOrders,
        schema.purchaseOrderItems,
        schema.goodsReceiptNotes,
        schema.goodsReceiptNoteItems,
        schema.purchaseBills,
        schema.purchaseReturns,
        schema.purchaseReturnItems,
        schema.physicalStockTakes,
        schema.physicalStockTakeItems,
        schema.inventoryStocks,
        schema.productCategories,
        schema.unitsOfMeasure,
        schema.productWarehouses,
      ];

      let sql = '-- PostgreSQL Database Backup\n\n';

      for (const table of tables) {
        const tableName = getTableName(table);
        const cols = getTableColumns(table);
        const dbColNames = Object.keys(cols).map(k => cols[k].name);
        
        let rows: any[] = [];
        try {
          // Try standard Postgres query
          rows = await db.select().from(table);
        } catch (dbErr: any) {
          console.error(`[Database] Export query failed for ${tableName}:`, dbErr.message);
        }
        
        if (!rows || rows.length === 0) continue;
        
        sql += `-- Table: ${tableName}\n`;
        for (const row of rows) {
          const values = Object.keys(cols).map(k => {
            const val = row[k];
            if (val === null || val === undefined) return 'NULL';
            if (typeof val === 'boolean') return val ? 'true' : 'false';
            if (typeof val === 'number') return val;
            if (val instanceof Date) return `'${val.toISOString()}'`;
            if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
            return `'${String(val).replace(/'/g, "''")}'`;
          });
          sql += `INSERT INTO "${tableName}" ("${dbColNames.join('", "')}") VALUES (${values.join(', ')}) ON CONFLICT DO NOTHING;\n`;
        }
        sql += '\n';
      }

      res.setHeader('Content-Type', 'application/sql');
      res.setHeader('Content-Disposition', 'attachment; filename="postgres_backup.sql"');
      res.send(sql);
    } catch (error) {
      console.error("Export SQL error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/state", async (req: any, res: any) => {
    try {
      // This response changes on every write anywhere in the app (a new GRN/invoice/
      // expense/etc.) and Express's default `res.json()` only sets a weak ETag, no
      // Cache-Control — enough for some browsers to serve a stale disk-cached copy
      // even across an ordinary reload (not just back-forward cache), which reads to a
      // user as "I just created X and a refresh still doesn't show it" even though the
      // server and DB are already correct. Force real revalidation every time.
      res.set('Cache-Control', 'no-store');
      const { getFullState } = await import('./src/db/apiState.js');
      // Scope state by companyId
      const state = await getFullState();
      
      const isSuper = req.user?.isSuperAdmin === true || req.user?.role === 'super-admin';
      const companyId = req.targetCompanyId || req.user?.companyId || req.session?.companyId;

      // Branch (physical-location) scoping — req.allowedBranchIds is null for an admin/
      // super-admin/branches.viewAllBranches holder (no ceiling, see isAuthenticated in
      // this file), otherwise the exact set from userBranches for a restricted user. A
      // document with no branchId at all (branchId == null) stays visible to everyone —
      // it predates branch adoption or the company never adopted branches, and hiding it
      // from a restricted user would be a regression (data they could see yesterday
      // disappearing), not a real isolation improvement. GRN/Purchase Returns/Physical
      // Stock Takes have no branchId column of their own (see schema.ts) — their branch is
      // derived via warehouseId, resolved once here rather than re-joined per row.
      const branchOk = (branchId: string | null | undefined): boolean => {
        if (req.allowedBranchIds === null || req.allowedBranchIds === undefined) return true;
        if (branchId == null) return true;
        return Array.isArray(req.allowedBranchIds) && req.allowedBranchIds.includes(branchId);
      };
      const branchIdByWarehouseId = new Map((state.warehouses || []).map((w: any) => [w.id, w.branchId]));
      const branchOkViaWarehouse = (warehouseId: string | null | undefined): boolean =>
        branchOk(warehouseId ? (branchIdByWarehouseId.get(warehouseId) as string | null | undefined) : undefined);

      // Every business/transaction field is scoped to `companyId` unconditionally, even
      // for a super-admin — a super-admin browsing one company must never receive every
      // other tenant's data in the same payload just because their role bypasses the
      // filter. `companyId` is resolved from the client's explicit selection
      // (`req.targetCompanyId`, set by the `?companyId=` query param — see
      // `isAuthenticated`), not from the caller's own home company, so switching the
      // company selector in the UI genuinely changes what this endpoint returns.
      // The one deliberate exception is `companies` itself: a super-admin needs the full
      // list to populate the company-switcher UI they use to change `companyId` in the
      // first place — that's navigation metadata, not tenant business data.
      const filteredState = {
        ...state,
        companies: isSuper ? state.companies : state.companies.filter((c: any) => c.id === companyId),
        templates: state.templates.filter((t: any) => t.companyId === companyId),
        products: state.products.filter((p: any) => p.companyId === companyId),
        customers: state.customers.filter((c: any) => c.companyId === companyId),
        vendors: state.vendors.filter((v: any) => v.companyId === companyId),
        banks: state.banks.filter((b: any) => b.companyId === companyId),
        months: state.months.filter((m: any) => m.companyId === companyId),
        quotations: state.quotations.filter((q: any) => q.companyId === companyId && branchOk(q.branchId)),
        invoices: state.invoices.filter((i: any) => i.companyId === companyId && branchOk(i.branchId)),
        expenses: state.expenses.filter((e: any) => e.companyId === companyId && branchOk(e.branchId)),
        recurringTemplates: state.recurringTemplates.filter((r: any) => r.companyId === companyId),
        recurringPostings: state.recurringPostings.filter((rp: any) => rp.companyId === companyId),
        vouchers: state.vouchers.filter((v: any) => v.companyId === companyId && branchOk(v.branchId)),
        investors: state.investors.filter((inv: any) => inv.companyId === companyId),
        posShifts: state.posShifts.filter((ps: any) => ps.companyId === companyId && branchOk(ps.branchId)),
        posHeldInvoices: state.posHeldInvoices.filter((ph: any) => ph.companyId === companyId && branchOk(ph.branchId)),
        productCategories: (state.productCategories || []).filter((c: any) => c.companyId === companyId),
        unitsOfMeasure: (state.unitsOfMeasure || []).filter((u: any) => u.companyId === companyId),
        // Company-scoped only, no branch dimension — same convention as unitsOfMeasure/
        // productCategories above (a stated design decision, see the POS grid/modifiers
        // feature plan: modifier groups are company-wide, matching how products/tax slabs
        // already work). Each product's own modifierGroupIds (embedded in `products`
        // above) already only ever reference this same company's groups by construction
        // (enforced at write-time by assertModifierGroupsOwnedByCompany), so filtering
        // this master list is the only cross-tenant surface here.
        modifierGroups: (state.modifierGroups || []).filter((g: any) => g.companyId === companyId),
        productWarehouses: (state.productWarehouses || []).filter((pw: any) => pw.companyId === companyId && branchOkViaWarehouse(pw.warehouseId)),
        // productUnitConversions has no companyId column of its own (schema.ts) — it's
        // scoped only indirectly via productId -> productsServices.companyId. Never added
        // to this filtered response at all (same gap as employees/jobTitles below), so
        // every tenant's packaging/barcode/bulk-pricing rows leaked to every other tenant
        // via the raw `...state` spread.
        productUnitConversions: (() => {
          const companyProductIds = new Set((state.products || []).filter((p: any) => p.companyId === companyId).map((p: any) => p.id));
          return (state.productUnitConversions || []).filter((puc: any) => companyProductIds.has(puc.productId));
        })(),
        // Company-scoped only (no branchOk) — same treatment as productCategories/
        // unitsOfMeasure above, not the branch-restricted documents below. Employees are
        // master/reference data, not a transactional document a branch user shouldn't see:
        // a Head-Office employee (branchId null) must reach every branch's invoice picker,
        // and InvoiceModule/EmployeesModule already do their own branchId narrowing
        // client-side (see eligibleSalesAssociates in InvoiceModule.tsx) — this filter only
        // needs to stop OTHER COMPANIES' employees/job titles from leaking across tenants,
        // which — until this fix — it didn't: these two were never added to this filtered
        // response at all, so every request received every company's employees/job titles
        // unfiltered via the raw `...state` spread below (harmless in practice only because
        // every client-side consumer happens to filter by companyId itself; still a real
        // cross-tenant leak over the wire).
        // Head-Office employees (branchId null) stay visible to every branch — see
        // employees's schema comment and InvoiceModule.tsx's eligibleSalesAssociates,
        // which already depends on this — but a branch-restricted viewer must not see
        // another branch's own staff roster (PII: email/phone, hire/termination dates).
        employees: (state.employees || []).filter((e: any) =>
          e.companyId === companyId && (req.allowedBranchIds === null || req.allowedBranchIds === undefined || e.branchId === null || e.branchId === undefined || req.allowedBranchIds.includes(e.branchId))
        ),
        jobTitles: (state.jobTitles || []).filter((jt: any) => jt.companyId === companyId),
        taxSlabs: (state.taxSlabs || []).filter((t: any) => t.companyId === companyId || t.companyId == null),
        warehouses: (state.warehouses || []).filter((w: any) => w.companyId === companyId && branchOk(w.branchId)),
        purchaseRequisitions: (state.purchaseRequisitions || []).filter((pr: any) => pr.companyId === companyId && branchOk(pr.branchId)),
        purchaseOrders: (state.purchaseOrders || []).filter((po: any) => po.companyId === companyId && branchOk(po.branchId)),
        goodsReceiptNotes: (state.goodsReceiptNotes || []).filter((g: any) => g.companyId === companyId && branchOkViaWarehouse(g.warehouseId)),
        inventoryStocks: (state.inventoryStocks || []).filter((s: any) => s.companyId === companyId && branchOkViaWarehouse(s.warehouseId)),
        purchaseBills: (state.purchaseBills || []).filter((b: any) => b.companyId === companyId && branchOk(b.branchId)),
        purchaseReturns: (state.purchaseReturns || []).filter((r: any) => r.companyId === companyId && branchOkViaWarehouse(r.warehouseId)),
        physicalStockTakes: (state.physicalStockTakes || []).filter((s: any) => s.companyId === companyId && branchOkViaWarehouse(s.warehouseId)),
        stockLedgerTransactions: (state.stockLedgerTransactions || []).filter((s: any) => s.companyId === companyId && branchOkViaWarehouse(s.warehouseId)),
        // Deliberately asymmetric, unlike every single-warehouse document type above: a
        // dispatch is visible if it leaves YOUR warehouse (regardless of destination), a
        // receiving is visible if it arrived at YOUR warehouse (regardless of source) — a
        // branch-restricted user genuinely needs to see both "stock I sent out" and "stock
        // that arrived here" even when the other end belongs to a branch they can't otherwise touch.
        warehouseDispatches: (state.warehouseDispatches || []).filter((d: any) => d.companyId === companyId && branchOkViaWarehouse(d.fromWarehouseId)),
        warehouseReceivings: (state.warehouseReceivings || []).filter((r: any) => r.companyId === companyId && branchOkViaWarehouse(r.toWarehouseId)),
        roles: (state.roles || []).filter((r: any) => r.companyId === companyId),
        branches: (state.branches || []).filter((b: any) => b.companyId === companyId),
        // userRoles is a plain (userId, roleId) join row with no companyId of its own —
        // scope it via which users actually belong to this company, the same way every
        // other field above is scoped, instead of returning every tenant's assignments.
        userRoles: (() => {
          const companyUserIds = new Set((state.users || []).filter((u: any) => u.companyId === companyId).map((u: any) => u.id));
          return (state.userRoles || []).filter((ur: any) => companyUserIds.has(ur.userId));
        })(),
        // Same reasoning as userRoles just above — userBranches has no companyId of its
        // own, scope it via which users actually belong to this company.
        userBranches: (() => {
          const companyUserIds = new Set((state.users || []).filter((u: any) => u.companyId === companyId).map((u: any) => u.id));
          return (state.userBranches || []).filter((ub: any) => companyUserIds.has(ub.userId));
        })(),
        users: (() => {
          const rolePermissionsById = new Map((state.roles || []).map((r: any) => [r.id, r.permissions]));
          const roleIdsByUserId = new Map<string, string[]>();
          for (const ur of (state.userRoles || [])) {
            const list = roleIdsByUserId.get(ur.userId) || [];
            list.push(ur.roleId);
            roleIdsByUserId.set(ur.userId, list);
          }
          // The logged-in user's own row must always be present regardless of company
          // scoping - a super-admin viewing a *different* company than their own home
          // company still needs their own account (currentUser, permissions) resolved.
          return state.users
            .filter((u: any) => u.companyId === companyId || u.id === req.user?.id)
            .filter((u: any) => u.isDeleted !== 1)
            .map((u: any) => {
              const { password, ...userWithoutPassword } = u;
              const assignedRoleIds = roleIdsByUserId.get(u.id) || [];
              const mergedPermissions = assignedRoleIds.length
                ? mergeRolePermissions(assignedRoleIds.map((id: string) => rolePermissionsById.get(id)))
                : null;
              return { ...userWithoutPassword, permissions: mergedPermissions };
            });
        })()
      };
      res.json(filteredState);
    } catch (error: any) {
      console.error("State endpoint error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/download-source-code", isAdmin, async (req, res) => {
    try {
      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip();
      
      // Zip files and directories to include
      if (fs.existsSync('./src')) {
        zip.addLocalFolder('./src', 'src');
      }
      if (fs.existsSync('./public')) {
        zip.addLocalFolder('./public', 'public');
      }
      if (fs.existsSync('./assets')) {
        zip.addLocalFolder('./assets', 'assets');
      }
      
      const filesToInclude = [
        './package.json',
        './tsconfig.json',
        './vite.config.ts',
        './server.ts',
        './BACKLOG.md'
      ];
      
      for (const file of filesToInclude) {
        if (fs.existsSync(file)) {
          zip.addLocalFile(file);
        }
      }
      
      const zipBuffer = zip.toBuffer();
      
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="source_code.zip"');
      res.send(zipBuffer);
    } catch (error) {
      console.error("Source code zip error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/register-missing-key", async (req: any, res: any) => {
    try {
      const { key } = req.body;
      if (!key || typeof key !== 'string') {
        return res.status(400).json({ error: "key must be a non-empty string" });
      }

      // 1. Check if key is already registered in DB
      const [existing] = await db.select()
        .from(schema.translations)
        .where(eq(schema.translations.key, key))
        .limit(1);

      if (existing) {
        return res.json({ status: "exists", item: existing });
      }

      // Look up in pre-seeded static dictionary
      let initialAr = "";
      let initialUr = "";
      try {
        const { SEED_TRANSLATIONS } = await import('./src/dbStore.js');
        const staticItem = SEED_TRANSLATIONS.find((t: any) => t.key === key);
        if (staticItem) {
          initialAr = staticItem.ar || "";
          initialUr = staticItem.ur || "";
        }
      } catch (e) {
        console.warn("Failed to load static translations for offline fallback:", e);
      }

      // 2. Generate a unique ID
      const id = generateId();
      const newItem = {
        id,
        key,
        en: key,
        ar: initialAr,
        ur: initialUr
      };

      // 3. Save to database immediately so it is available
      await db.insert(schema.translations).values(newItem);

      // If we already resolved it offline, we don't need to invoke Gemini
      if (initialAr && initialUr) {
        return res.status(201).json({ status: "created", item: newItem, fallbackUsed: true });
      }

      // 4. Translate in the background asynchronously using Gemini if available
      const apiKey = process.env.GEMINI_API_KEY;
      if (apiKey) {
        // Fire-and-forget background translation task
        (async () => {
          try {
            const { GoogleGenAI } = await import("@google/genai");
            const ai = new GoogleGenAI({
              apiKey: apiKey,
              httpOptions: {
                headers: {
                  'User-Agent': 'aistudio-build',
                }
              }
            });

            const prompt = `You are an expert enterprise software translator specialized in manufacturing, ERP, and precision engineering terminologies for Arabic and Urdu regions.
Translate the following English user interface (UI) key/phrase into authentic, natural, professional, and standard enterprise Arabic (ar) and Urdu (ur).
Key/phrase: "${key}"

Respond STRICTLY with a valid JSON object matching this schema:
{
  "ar": "Professional Arabic software translation",
  "ur": "Professional Urdu software translation"
}
Do NOT wrap the response in any introductory, markdown formatting (no \`\`\`json), or explanatory text. Return ONLY the raw JSON object.`;

            const response = await ai.models.generateContent({
              model: "gemini-3.6-flash",
              contents: prompt,
              config: {
                responseMimeType: "application/json",
              }
            });

            const textResponse = response.text;
            if (textResponse) {
              const parsed = JSON.parse(textResponse.trim());
              if (parsed && (parsed.ar || parsed.ur)) {
                await db.update(schema.translations)
                  .set({
                    ar: parsed.ar || "",
                    ur: parsed.ur || ""
                  })
                  .where(eq(schema.translations.id, id));
                console.log(`[Auto-Translate] Successfully translated missing key "${key}" to ar="${parsed.ar}", ur="${parsed.ur}"`);
              }
            }
          } catch (transErr: any) {
            const errStr = String(transErr.message || transErr || "");
            if (errStr.includes("PERMISSION_DENIED") || errStr.includes("denied access") || errStr.includes("403")) {
              console.log(`[Auto-Translate] Translation is currently restricted or unauthorized for key "${key}". Using offline fallback.`);
            } else {
              console.log(`[Auto-Translate] Could not translate key "${key}" automatically. Using offline fallback.`);
            }
          }
        })();
      }

      res.status(201).json({ status: "created", item: newItem });
    } catch (error: any) {
      console.error("Register missing key error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // The bulk "Auto-Translate (Gemini)" endpoint that used to live here was removed by
  // explicit product decision — Translations tab edits are single-record, explicit
  // transactions only (Create/Update/Delete), never a whole-array sync. Per-key
  // auto-translation on first use still happens above, in /api/register-missing-key.

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Auto-seed database on startup if empty & ensure all passwords are hashed
  try {
    const usersInDb = await db.select().from(schema.users).catch(() => []);
    if (usersInDb.length === 0) {
      console.log("[Startup] Postgres database is empty. Running auto-seeding with INITIAL_DB...");
      const { INITIAL_DB } = await import('./src/dbStore.js');
      const { migrateDataToPostgres } = await import('./src/db/migrateData.js');
      await migrateDataToPostgres(INITIAL_DB);
      console.log("[Startup] Auto-seeding completed successfully!");
    } else {
      console.log(`[Startup] Postgres database is already initialized with ${usersInDb.length} users.`);
      // Enforce bcrypt hash on all existing plain text passwords in the DB
      for (const user of usersInDb) {
        if (user.password && !user.password.startsWith('$2b$') && !user.password.startsWith('$2a$')) {
          console.log(`[Startup] Auto-hashing plain-text password for user: ${user.username}`);
          const hashedPassword = await bcrypt.hash(user.password, 10);
          await db.update(schema.users).set({ password: hashedPassword }).where(eq(schema.users.id, user.id));
        }
      }
    }
  } catch (err: any) {
    console.error("[Startup] Error during seeding check:", err);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
