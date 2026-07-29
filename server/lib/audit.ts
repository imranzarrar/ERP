import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';

/**
 * Records an audit log entry in the relational database.
 * Designed to handle errors gracefully so that failing to write an audit log does not crash the client request.
 */
export async function recordAuditLog(
  req: any,
  action: string,
  entityType: string,
  entityId: string | null = null,
  details: any = null
) {
  try {
    const userId = req?.user?.id || null;
    const username = req?.user?.username || 'anonymous';
    const companyId = req?.targetCompanyId || req?.user?.companyId || null;
    const ipAddress = req?.headers?.['x-forwarded-for'] || req?.ip || req?.socket?.remoteAddress || null;

    let detailsString = null;
    if (details) {
      if (typeof details === 'object') {
        detailsString = JSON.stringify(details);
      } else {
        detailsString = String(details);
      }
    }

    await db.insert(schema.auditLogs).values({
      companyId,
      userId,
      username,
      action,
      entityType,
      entityId,
      details: detailsString,
      ipAddress,
      createdAt: new Date(),
    });
  } catch (error) {
    console.error('[Audit] Failed to insert audit log:', error);
  }
}
