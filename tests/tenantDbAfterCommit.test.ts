import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { withTenantDb, tenantDb, runAfterTenantCommit } from '../server/lib/tenantDb.js';

// Regression/design-verification test for runAfterTenantCommit — added while migrating
// transactions.ts's invoice-creation route (RLS full-rollout, Phase 3), which fires
// processInvoiceZatca(savedInvoiceId) as fire-and-forget immediately after its
// transaction commits. processInvoiceZatca does its OWN database queries via a SEPARATE
// connection (never the request's own tenantDb client), so it can only safely run once
// the write is genuinely durable and visible outside this transaction. Calling it
// directly inside a tenantDb-backed handler would be wrong: under withTenantDb's
// commit-at-response-time design (see tenantDb.ts's res.end override), the actual COMMIT
// doesn't happen until the response is about to be sent — a callback fired earlier, mid-
// handler, would race ahead of it and query a row that doesn't exist yet on any other
// connection.
//
// This test builds a tiny standalone Express app (not the real server) to exercise
// withTenantDb/runAfterTenantCommit/tenantDb in isolation, proving: (1) a callback
// registered via runAfterTenantCommit only runs after res.end() has triggered a real
// COMMIT, and (2) by the time it runs, the write it depends on is visible via a
// completely separate (superuser) connection — exactly the guarantee
// processInvoiceZatca's fire-and-forget call needs.
let server: Server;
let baseUrl: string;
let testCompanyId: string;
let insertedCustomerId: string | undefined;
const observedOrder: string[] = [];
let visibleAtCallbackTime = false;

async function makeCompany(name: string) {
  const id = generateId();
  await db.insert(schema.companies).values({
    id, name, address: 'Test Address', phone: '0000000000', email: `${id}@example.com`,
    logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false,
  });
  return id;
}

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (insertedCustomerId) {
    await db.delete(schema.customers).where(eq(schema.customers.id, insertedCustomerId));
  }
  await db.delete(schema.companies).where(eq(schema.companies.id, testCompanyId));
});

describe('runAfterTenantCommit — fires only after a genuine COMMIT, with the write already visible elsewhere', () => {
  it('sets up a throwaway app, company, and route exercising the real middleware', async () => {
    testCompanyId = await makeCompany('runAfterTenantCommit Test Co');

    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.targetCompanyId = testCompanyId;
      next();
    });
    app.post('/test-insert', withTenantDb, async (req: any, res) => {
      const tdb = tenantDb();
      const id = generateId();
      await tdb.insert(schema.customers).values({
        id, name: 'Committed via runAfterTenantCommit test', phone: '1', email: 'x@example.com',
        address: 'A', companyId: testCompanyId, buyerType: 'B2C',
      });
      observedOrder.push('handler-finished-insert');
      runAfterTenantCommit(() => {
        observedOrder.push('after-commit-callback-fired');
        // Deliberately the superuser `db` — a totally separate connection than the one
        // tenantDb used for the insert above. If this callback fired before the real
        // COMMIT, this row would not exist yet on this connection.
        db.select().from(schema.customers).where(eq(schema.customers.id, id)).then((rows) => {
          visibleAtCallbackTime = rows.length === 1;
        });
      });
      insertedCustomerId = id;
      res.json({ success: true, id });
      observedOrder.push('handler-returned');
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  it('the callback fires after the handler returns, and the write is already visible on a separate connection by then', async () => {
    const res = await fetch(`${baseUrl}/test-insert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(200);

    // Give the fire-and-forget internals (finalize -> afterCommit callbacks -> the
    // callback's own async select) a moment to complete — the HTTP response itself is
    // already guaranteed to be sent only after finalize resolves; this just waits for the
    // callback's own inner .then() to run too, since that part is genuinely fire-and-forget
    // (mirroring processInvoiceZatca's own real shape).
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(observedOrder).toEqual(['handler-finished-insert', 'handler-returned', 'after-commit-callback-fired']);
    expect(visibleAtCallbackTime, 'the row must already be visible on a separate connection by the time the afterCommit callback runs').toBe(true);
  });
});
