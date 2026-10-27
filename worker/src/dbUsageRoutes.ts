// Admin endpoints to measure what the database costs (Turso free plan limits):
//   GET /api/admin/db-usage?days=7  rows read/written per endpoint, recorded while DB_METRICS = "1"
//   GET /api/admin/db-size          rows and approximate bytes per table
// Both need "Authorization: Bearer <UPSTASH_CRON_SECRET>".

import type { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { requireAdmin, type AppEnv } from './auth';
import { createDb } from './db';
import { isDbMetricsEnabled } from './dbMetrics';

/** Turso free plan, per month */
const FREE_ROWS_READ = 500_000_000;
const FREE_ROWS_WRITTEN = 10_000_000;
const FREE_STORAGE_BYTES = 5 * 1024 ** 3;

const percent = (value: number, limit: number) => Math.round((value / limit) * 1000) / 10;

export function registerDbUsageRoutes(app: Hono<AppEnv>) {
  app.get('/api/admin/db-usage', requireAdmin, async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL, c.env.TURSO_AUTH_TOKEN);
      const days = Math.min(Math.max(parseInt(c.req.query('days') || '7') || 7, 1), 90);
      const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);

      const exists: any[] = await db.all(sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'db_usage_daily'`);
      if (exists.length === 0) {
        return c.json({
          metricsEnabled: isDbMetricsEnabled(),
          message: 'No usage recorded yet: set the DB_METRICS variable to "1" in the Worker and wait for traffic.',
        });
      }

      const byLabel: any[] = await db.all(sql`
        SELECT label,
               SUM(requests) AS requests,
               SUM(statements) AS statements,
               SUM(rows_read) AS rowsRead,
               SUM(rows_written) AS rowsWritten,
               SUM(unreported) AS unreported
        FROM db_usage_daily
        WHERE day >= ${since}
        GROUP BY label
        ORDER BY rowsRead DESC
      `);
      const byDay: any[] = await db.all(sql`
        SELECT day,
               SUM(requests) AS requests,
               SUM(rows_read) AS rowsRead,
               SUM(rows_written) AS rowsWritten
        FROM db_usage_daily
        WHERE day >= ${since}
        GROUP BY day
        ORDER BY day
      `);

      const totalRead = byLabel.reduce((sum, row) => sum + Number(row.rowsRead), 0);
      const totalWritten = byLabel.reduce((sum, row) => sum + Number(row.rowsWritten), 0);

      // Project from complete days only (today is partial), unless today is all there is
      const fullDays = byDay.filter((row) => row.day !== today);
      const basis = fullDays.length > 0 ? fullDays : byDay;
      const avgRead = basis.reduce((sum, row) => sum + Number(row.rowsRead), 0) / Math.max(basis.length, 1);
      const avgWritten = basis.reduce((sum, row) => sum + Number(row.rowsWritten), 0) / Math.max(basis.length, 1);

      return c.json({
        metricsEnabled: isDbMetricsEnabled(),
        since,
        projection: {
          basedOnDays: basis.length,
          partialDayOnly: fullDays.length === 0,
          rowsReadPerMonth: Math.round(avgRead * 30),
          rowsReadPercentOfFreePlan: percent(avgRead * 30, FREE_ROWS_READ),
          rowsWrittenPerMonth: Math.round(avgWritten * 30),
          rowsWrittenPercentOfFreePlan: percent(avgWritten * 30, FREE_ROWS_WRITTEN),
        },
        byLabel: byLabel.map((row) => ({
          label: row.label,
          requests: Number(row.requests),
          statements: Number(row.statements),
          rowsRead: Number(row.rowsRead),
          rowsWritten: Number(row.rowsWritten),
          rowsReadPerRequest: Math.round(Number(row.rowsRead) / Math.max(Number(row.requests), 1)),
          shareOfRowsRead: totalRead > 0 ? percent(Number(row.rowsRead), totalRead) : 0,
          shareOfRowsWritten: totalWritten > 0 ? percent(Number(row.rowsWritten), totalWritten) : 0,
          unreported: Number(row.unreported),
        })),
        byDay: byDay.map((row) => ({
          day: row.day,
          requests: Number(row.requests),
          rowsRead: Number(row.rowsRead),
          rowsWritten: Number(row.rowsWritten),
        })),
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Reads every row of every table (costs about as many rows read as the database holds):
  // run it by hand, not on a schedule.
  app.get('/api/admin/db-size', requireAdmin, async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL, c.env.TURSO_AUTH_TOKEN);

      let fileBytes: number | null = null;
      try {
        const [pageCount]: any[] = await db.all(sql`PRAGMA page_count`);
        const [pageSize]: any[] = await db.all(sql`PRAGMA page_size`);
        fileBytes = Number(Object.values(pageCount)[0]) * Number(Object.values(pageSize)[0]);
      } catch {
        // Not every server allows these pragmas
      }

      // Exact bytes per table and index, when the server has the dbstat table
      let dbstat: Array<{ name: string; bytes: number }> | null = null;
      try {
        const rows: any[] = await db.all(sql`SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC`);
        dbstat = rows.map((row) => ({ name: row.name, bytes: Number(row.bytes) }));
      } catch {
        // Fall back to the data size of each table below
      }

      const tables: any[] = await db.all(sql`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%' AND name NOT LIKE 'libsql_%'
        ORDER BY name
      `);
      const perTable: Array<{ table: string; rows: number; dataBytes: number; largestColumns: Array<{ column: string; bytes: number }> }> = [];
      for (const { name } of tables) {
        const quotedTable = `"${String(name).replace(/"/g, '""')}"`;
        const columns: any[] = await db.all(sql.raw(`PRAGMA table_info(${quotedTable})`));
        if (columns.length === 0) continue;
        const sums = columns
          .map((col, i) => `COALESCE(SUM(LENGTH("${String(col.name).replace(/"/g, '""')}")), 0) AS c${i}`)
          .join(', ');
        const [row]: any[] = await db.all(sql.raw(`SELECT COUNT(*) AS row_count, ${sums} FROM ${quotedTable}`));
        const columnBytes = columns
          .map((col, i) => ({ column: String(col.name), bytes: Number(row[`c${i}`]) }))
          .sort((a, b) => b.bytes - a.bytes);
        perTable.push({
          table: String(name),
          rows: Number(row.row_count),
          dataBytes: columnBytes.reduce((sum, col) => sum + col.bytes, 0),
          largestColumns: columnBytes.slice(0, 3).filter((col) => col.bytes > 0),
        });
      }
      perTable.sort((a, b) => b.dataBytes - a.dataBytes);

      const dataBytes = perTable.reduce((sum, t) => sum + t.dataBytes, 0);
      return c.json({
        fileBytes,
        filePercentOfFreePlan: fileBytes !== null ? percent(fileBytes, FREE_STORAGE_BYTES) : null,
        dataBytes,
        dataPercentOfFreePlan: percent(dataBytes, FREE_STORAGE_BYTES),
        note: 'dataBytes = LENGTH() of every value (text/blob bytes; numbers count their digits); indexes and page overhead are not included.',
        tables: perTable,
        dbstat,
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });
}
