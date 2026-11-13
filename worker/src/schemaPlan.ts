/**
 * Schema set-up in two database round trips instead of one per statement.
 *
 * Every statement sent to Turso is an HTTP request, and Cloudflare allows a limited number of those
 * per invocation (50 on the free plan). Running each CREATE / ALTER one by one at the start of every
 * isolate took more than 100 and broke the first request (and, after the error, all of them).
 *
 * The set-up code still writes plain `db.run(sql...)` calls. Here they run against a collector that
 * already knows (one query on sqlite_master) which tables, columns and indexes exist: what exists is
 * skipped (an ALTER of an existing column fails, as it would on the database, so `tryRun` returns
 * false and a follow-up UPDATE is not queued), and whatever is left goes in one batch.
 */
import { sql } from 'drizzle-orm';
import type { Database } from './db';

type Statement = { sql: string; params: unknown[] };

export interface ExistingSchema {
  tables: Set<string>;
  indexes: Set<string>;
  columns: Map<string, Set<string>>;
}

export async function readExistingSchema(db: Database): Promise<ExistingSchema> {
  // One round trip: every table with its columns, and every index
  const rows = await db.all<{ type: string; name: string; col: string | null }>(sql`SELECT m.type AS type, m.name AS name, p.name AS col
    FROM sqlite_master m LEFT JOIN pragma_table_info(m.name) p ON m.type = 'table'
    WHERE m.type IN ('table', 'index')`);
  const schema: ExistingSchema = { tables: new Set(), indexes: new Set(), columns: new Map() };
  for (const row of rows) {
    const name = String(row.name).toLowerCase();
    if (row.type === 'index') {
      schema.indexes.add(name);
      continue;
    }
    schema.tables.add(name);
    if (!schema.columns.has(name)) schema.columns.set(name, new Set());
    if (row.col) schema.columns.get(name)!.add(String(row.col).toLowerCase());
  }
  return schema;
}

/** Column names declared in a CREATE TABLE statement (constraints skipped). */
export function columnsOfCreate(text: string): string[] {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close <= open) return [];
  const body = text.slice(open + 1, close);
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts
    .map((part) => part.trim().split(/\s+/)[0]?.replace(/["`[\]]/g, '').toLowerCase() ?? '')
    .filter((word) => word && !['primary', 'unique', 'foreign', 'check', 'constraint'].includes(word));
}

/**
 * What to do with one statement given the schema so far: 'skip' (already there), 'fail' (an ALTER
 * of an existing column: the caller sees the same error the database would give) or 'run'.
 * Updates `schema` as if the statement had run.
 */
export function planStatement(text: string, schema: ExistingSchema): 'run' | 'skip' | 'fail' {
  const createTable = /^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+["`]?(\w+)/i.exec(text);
  if (createTable) {
    const table = createTable[1].toLowerCase();
    if (schema.tables.has(table)) return 'skip';
    schema.tables.add(table);
    schema.columns.set(table, new Set(columnsOfCreate(text)));
    return 'run';
  }
  const createIndex = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+["`]?(\w+)/i.exec(text);
  if (createIndex) {
    const index = createIndex[1].toLowerCase();
    if (schema.indexes.has(index)) return 'skip';
    schema.indexes.add(index);
    return 'run';
  }
  const addColumn = /^\s*ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+ADD\s+COLUMN\s+["`]?(\w+)/i.exec(text);
  if (addColumn) {
    const table = addColumn[1].toLowerCase();
    const column = addColumn[2].toLowerCase();
    // A table that doesn't exist fails on the database too
    if (!schema.tables.has(table)) return 'fail';
    const columns = schema.columns.get(table)!;
    if (columns.has(column)) return 'fail';
    columns.add(column);
    return 'run';
  }
  return 'run';
}

/**
 * Runs `setup` (code written with db.run / db.all / db.batch) against a collector, then sends what
 * is missing in one batch. Reads (`db.all`, `db.get`) go to the real database.
 */
export async function applySchemaPlan(db: Database, setup: (collector: Database) => Promise<void>): Promise<{ statements: number }> {
  const schema = await readExistingSchema(db);
  const dialect = (db as any).dialect;
  const queued: Statement[] = [];
  const toStatement = (query: any): Statement => {
    if (typeof query === 'string') return { sql: query, params: [] };
    const built = dialect.sqlToQuery(query);
    return { sql: built.sql, params: built.params };
  };
  const run = async (query: any) => {
    const statement = toStatement(query);
    const decision = planStatement(statement.sql, schema);
    if (decision === 'fail') throw new Error(`[schema plan] ${statement.sql.slice(0, 80)}: already there or table missing`);
    if (decision === 'run') queued.push(statement);
    return { rowsAffected: 0, rows: [], columns: [] };
  };
  const collector: any = new Proxy(db as any, {
    get(target, prop) {
      if (prop === 'run') return run;
      if (prop === 'batch') return async (items: Array<Promise<unknown>>) => Promise.all(items);
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await setup(collector as Database);
  if (queued.length === 0) return { statements: 0 };
  const client = (db as any).$client ?? (db as any).session?.client;
  try {
    await client.batch(queued.map((s) => ({ sql: s.sql, args: s.params as any[] })), 'write');
  } catch (error) {
    // Something unexpected (a statement the plan got wrong): one by one, ignoring errors
    console.error('[SCHEMA] Batch failed, applying statements one by one:', error);
    for (const statement of queued) {
      try {
        await client.execute({ sql: statement.sql, args: statement.params as any[] });
      } catch (_) {
        /* already there */
      }
    }
  }
  console.log(`[SCHEMA] Applied ${queued.length} schema statement(s)`);
  return { statements: queued.length };
}
