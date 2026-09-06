import express from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and, gt, isNotNull, desc } from 'drizzle-orm';
import { isAdminUser, isSuperAdminUser } from '../lib/authz.js';

const router = express.Router();

// Admin-only, not a delegable permission leaf — forcibly viewing/ending another staff
// member's session belongs in the same tier as Roles/DB backup in this codebase, not
// something assignable via the ordinary CRUD permission model.
router.get('/admin/sessions', async (req: any, res) => {
  try {
    if (!isAdminUser(req.user)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = 50;

    const conditions = [gt(schema.user_sessions.expire, new Date()), isNotNull(schema.user_sessions.userId)];
    if (!isSuperAdminUser(req.user)) {
      conditions.push(eq(schema.user_sessions.companyId, req.targetCompanyId));
    }

    const rows = await db.select({
      sid: schema.user_sessions.sid,
      userId: schema.user_sessions.userId,
      companyId: schema.user_sessions.companyId,
      lastActivity: schema.user_sessions.lastActivity,
      expire: schema.user_sessions.expire,
      username: schema.users.username,
      role: schema.users.role,
      companyName: schema.companies.name,
    })
      .from(schema.user_sessions)
      .leftJoin(schema.users, eq(schema.user_sessions.userId, schema.users.id))
      .leftJoin(schema.companies, eq(schema.user_sessions.companyId, schema.companies.id))
      .where(and(...conditions))
      .orderBy(desc(schema.user_sessions.lastActivity))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    res.json({ sessions: rows, page, pageSize, currentSessionId: req.activeSessionId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/admin/sessions/:sid', async (req: any, res) => {
  try {
    if (!isAdminUser(req.user)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { sid } = req.params;

    if (sid === req.activeSessionId) {
      return res.status(400).json({ error: 'This is your own current session — use logout instead of revoking it here.' });
    }

    const [target] = await db.select().from(schema.user_sessions).where(eq(schema.user_sessions.sid, sid));
    if (!target) {
      return res.status(404).json({ error: 'Session not found.' });
    }
    if (!isSuperAdminUser(req.user) && target.companyId !== req.targetCompanyId) {
      return res.status(403).json({ error: 'Forbidden: this session belongs to another company.' });
    }

    await db.delete(schema.user_sessions).where(eq(schema.user_sessions.sid, sid));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
