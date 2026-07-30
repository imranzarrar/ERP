import 'dotenv/config';
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
import { mergeRolePermissions } from './src/types.js';
import { generateId } from './src/id.js';
import { recordAuditLog } from './server/lib/audit.js';
import masterEntitiesRouter from './server/routes/masterEntities.js';
import usersRouter from './server/routes/users.js';
import rolesRouter from './server/routes/roles.js';
import transactionsRouter from './server/routes/transactions.js';
import expensesRouter from './server/routes/expenses.js';
import posRouter from './server/routes/pos.js';
import zatcaRouter from './server/routes/zatca.js';
import inventoryRouter from './server/routes/inventory.js';

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
  class ResilientSessionStore extends session.Store {
    private pgStore: any;
    private memStore: any;
    private useBackup: boolean = false;

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
          this.useBackup = true;
        });
      } catch (e: any) {
        console.warn("[Session] Failed to initialize PgSession, using MemoryStore:", e.message);
        this.useBackup = true;
      }
    }

    get(sid: string, callback: any) {
      if (this.useBackup || !this.pgStore) {
        return this.memStore.get(sid, callback);
      }
      this.pgStore.get(sid, (err: any, session: any) => {
        if (err) {
          console.warn("[Session] PgSession.get failed, falling back to MemoryStore:", err.message);
          this.useBackup = true;
          return this.memStore.get(sid, callback);
        }
        callback(null, session);
      });
    }

    set(sid: string, session: any, callback: any) {
      if (this.useBackup || !this.pgStore) {
        return this.memStore.set(sid, session, callback);
      }
      this.pgStore.set(sid, session, (err: any) => {
        if (err) {
          console.warn("[Session] PgSession.set failed, falling back to MemoryStore:", err.message);
          this.useBackup = true;
          return this.memStore.set(sid, session, callback);
        }
        if (callback) callback(null);
      });
    }

    destroy(sid: string, callback: any) {
      if (this.useBackup || !this.pgStore) {
        return this.memStore.destroy(sid, callback);
      }
      this.pgStore.destroy(sid, (err: any) => {
        if (err) {
          return this.memStore.destroy(sid, callback);
        }
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

    if (!userId && resolvedSessionId) {
      try {
        const [sessionRow] = await db.select()
          .from(schema.user_sessions)
          .where(eq(schema.user_sessions.sid, String(resolvedSessionId)));

        if (sessionRow && sessionRow.sess && sessionRow.expire > new Date()) {
          const sessionData = sessionRow.sess as any;
          if (sessionData && sessionData.userId) {
            userId = sessionData.userId;
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

        // Determine target company
        let companyId = req.query.companyId || req.body.companyId || req.headers['x-company-id'];

        if (companyId) {
          if (user.role === 'super-admin' || user.isSuperAdmin === true) {
            req.targetCompanyId = companyId;
          } else if (user.companyId && companyId !== user.companyId) {
            req.targetCompanyId = user.companyId;
          } else {
            req.targetCompanyId = companyId;
          }
        } else {
          req.targetCompanyId = user.companyId;
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

  // API Routes (Public)
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Protect remaining routes
  app.use('/api', isAuthenticated);

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
  app.use('/api/users', usersRouter);
  app.use('/api/roles', rolesRouter);
  app.use('/api/transactions', transactionsRouter);
  app.use('/api/expenses', expensesRouter);
  app.use('/api/pos', posRouter);
  app.use('/api/zatca', zatcaRouter);
  app.use('/api/inventory', inventoryRouter);

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
      const { getFullState } = await import('./src/db/apiState.js');
      // Scope state by companyId
      const state = await getFullState();
      
      const isSuper = req.user?.isSuperAdmin === true || req.user?.role === 'super-admin';
      const companyId = req.targetCompanyId || req.user?.companyId || req.session?.companyId;
      
      // Filter state by companyId and remove passwords from users
      const filteredState = {
        ...state,
        companies: isSuper ? state.companies : state.companies.filter((c: any) => c.id === companyId),
        templates: isSuper ? state.templates : state.templates.filter((t: any) => t.companyId === companyId),
        products: isSuper ? state.products : state.products.filter((p: any) => p.companyId === companyId),
        customers: isSuper ? state.customers : state.customers.filter((c: any) => c.companyId === companyId),
        vendors: isSuper ? state.vendors : state.vendors.filter((v: any) => v.companyId === companyId),
        banks: isSuper ? state.banks : state.banks.filter((b: any) => b.companyId === companyId),
        months: isSuper ? state.months : state.months.filter((m: any) => m.companyId === companyId),
        quotations: isSuper ? state.quotations : state.quotations.filter((q: any) => q.companyId === companyId),
        invoices: isSuper ? state.invoices : state.invoices.filter((i: any) => i.companyId === companyId),
        expenses: isSuper ? state.expenses : state.expenses.filter((e: any) => e.companyId === companyId),
        recurringTemplates: isSuper ? state.recurringTemplates : state.recurringTemplates.filter((r: any) => r.companyId === companyId),
        recurringPostings: isSuper ? state.recurringPostings : state.recurringPostings.filter((rp: any) => rp.companyId === companyId),
        vouchers: isSuper ? state.vouchers : state.vouchers.filter((v: any) => v.companyId === companyId),
        investors: isSuper ? state.investors : state.investors.filter((inv: any) => inv.companyId === companyId),
        posShifts: isSuper ? state.posShifts : state.posShifts.filter((ps: any) => ps.companyId === companyId),
        posHeldInvoices: isSuper ? state.posHeldInvoices : state.posHeldInvoices.filter((ph: any) => ph.companyId === companyId),
        productCategories: isSuper ? state.productCategories : (state.productCategories || []).filter((c: any) => c.companyId === companyId),
        unitsOfMeasure: isSuper ? state.unitsOfMeasure : (state.unitsOfMeasure || []).filter((u: any) => u.companyId === companyId),
        productWarehouses: isSuper ? state.productWarehouses : (state.productWarehouses || []).filter((pw: any) => pw.companyId === companyId),
        taxSlabs: isSuper ? state.taxSlabs : (state.taxSlabs || []).filter((t: any) => t.companyId === companyId || t.companyId == null),
        warehouses: isSuper ? state.warehouses : (state.warehouses || []).filter((w: any) => w.companyId === companyId),
        purchaseRequisitions: isSuper ? state.purchaseRequisitions : (state.purchaseRequisitions || []).filter((pr: any) => pr.companyId === companyId),
        purchaseOrders: isSuper ? state.purchaseOrders : (state.purchaseOrders || []).filter((po: any) => po.companyId === companyId),
        goodsReceiptNotes: isSuper ? state.goodsReceiptNotes : (state.goodsReceiptNotes || []).filter((g: any) => g.companyId === companyId),
        inventoryStocks: isSuper ? state.inventoryStocks : (state.inventoryStocks || []).filter((s: any) => s.companyId === companyId),
        roles: isSuper ? state.roles : (state.roles || []).filter((r: any) => r.companyId === companyId),
        // userRoles is a plain (userId, roleId) join row with no companyId of its own —
        // scope it via which users actually belong to this company, the same way every
        // other field above is scoped, instead of returning every tenant's assignments.
        userRoles: isSuper ? (state.userRoles || []) : (() => {
          const companyUserIds = new Set((state.users || []).filter((u: any) => u.companyId === companyId).map((u: any) => u.id));
          return (state.userRoles || []).filter((ur: any) => companyUserIds.has(ur.userId));
        })(),
        users: (() => {
          const rolePermissionsById = new Map((state.roles || []).map((r: any) => [r.id, r.permissions]));
          const roleIdsByUserId = new Map<string, string[]>();
          for (const ur of (state.userRoles || [])) {
            const list = roleIdsByUserId.get(ur.userId) || [];
            list.push(ur.roleId);
            roleIdsByUserId.set(ur.userId, list);
          }
          return (isSuper ? state.users : state.users.filter((u: any) => u.companyId === companyId))
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

  app.post("/api/translate-all", async (req: any, res: any) => {
    const translations = req.body?.translations;
    try {
      if (!Array.isArray(translations)) {
        return res.status(400).json({ error: "translations must be an array" });
      }

      // Filter translations that actually need translation (missing 'ar' or 'ur')
      const needsTranslation = translations.filter(t => !t.ar || !t.ur);
      if (needsTranslation.length === 0) {
        return res.json({ translations });
      }

      // 1. Resolve offline translations using pre-seeded dictionary
      try {
        const { SEED_TRANSLATIONS } = await import('./src/dbStore.js');
        needsTranslation.forEach(item => {
          const staticItem = SEED_TRANSLATIONS.find((st: any) => st.key === item.key);
          if (staticItem) {
            item.ar = item.ar || staticItem.ar || "";
            item.ur = item.ur || staticItem.ur || "";
          }
        });
      } catch (e) {
        console.warn("Failed to load static dictionary for bulk translation offline fallback:", e);
      }

      // Filter again to see what is still missing translation
      const remainingNeedsTranslation = needsTranslation.filter(t => !t.ar || !t.ur);
      const results = [...translations];

      // 2. Only call Gemini for remaining missing items if key is configured
      const apiKey = process.env.GEMINI_API_KEY;
      if (remainingNeedsTranslation.length > 0 && apiKey) {
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

          // Split into batches of 15 to ensure high quality and response limit safety
          const batchSize = 15;
          for (let i = 0; i < remainingNeedsTranslation.length; i += batchSize) {
            const batch = remainingNeedsTranslation.slice(i, i + batchSize);
            
            const prompt = `You are an expert enterprise software translator specialized in manufacturing, ERP, and precision engineering terminologies for Arabic and Urdu regions.
Translate the following English user interface (UI) keys and phrases into authentic, natural, professional, and standard enterprise Arabic (ar) and Urdu (ur).
For each item, preserve proper professional software context. For example, "Post" in accounting means "ترحيل" (Arabic) or "پوسٹ کریں" (Urdu). "Draft" is "مسودة" (Arabic) or "مسودہ" (Urdu).

Respond STRICTLY with a valid JSON array of objects following this TypeScript interface:
interface TranslatedItem {
  id: string;
  key: string;
  ar: string; // Professional Arabic software translation
  ur: string; // Professional Urdu software translation
}

Do NOT wrap the response in any introductory or explanatory text. Return ONLY the raw JSON array.

Input batch items to translate:
${JSON.stringify(batch.map(item => ({ id: item.id, key: item.key, en: item.en || item.key })))}
`;

            try {
              const response = await ai.models.generateContent({
                model: "gemini-3.6-flash",
                contents: prompt,
                config: {
                  responseMimeType: "application/json",
                }
              });

              const textResponse = response.text;
              if (textResponse) {
                const parsedBatch = JSON.parse(textResponse.trim());
                if (Array.isArray(parsedBatch)) {
                  parsedBatch.forEach((translatedItem: any) => {
                    const index = results.findIndex(r => r.id === translatedItem.id);
                    if (index !== -1) {
                      results[index] = {
                        ...results[index],
                        ar: results[index].ar || translatedItem.ar || "",
                        ur: results[index].ur || translatedItem.ur || ""
                      };
                    }
                  });
                }
              }
            } catch (batchErr: any) {
              const errStr = String(batchErr.message || batchErr || "");
              if (errStr.includes("PERMISSION_DENIED") || errStr.includes("denied access") || errStr.includes("403")) {
                console.log("[Translation API] Translation service restricted. Using static fallback dictionary.");
              } else {
                console.log("[Translation API] AI batch translation unavailable. Using static fallback dictionary.");
              }
            }
          }
        } catch (apiErr: any) {
          console.log("[Translation API] AI client unavailable. Using static fallback dictionary.");
        }
      } else if (remainingNeedsTranslation.length > 0) {
        console.log("[Translation API] No GEMINI_API_KEY available or remaining items are already processed.");
      }

      // 3. Upsert results to Postgres DB
      for (const t of results) {
        await db.insert(schema.translations)
          .values({
            id: t.id,
            key: t.key,
            en: t.en || t.key,
            ar: t.ar || "",
            ur: t.ur || ""
          })
          .onConflictDoUpdate({
            target: schema.translations.id,
            set: {
              ar: t.ar || "",
              ur: t.ur || ""
            }
          });
      }

      res.json({ translations: results });
    } catch (error: any) {
      console.warn("[Translation API] Translation process warn:", error);
      // Return the current list (with offline ones applied) to client instead of 500
      res.json({ translations: translations, warn: error.message });
    }
  });

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
