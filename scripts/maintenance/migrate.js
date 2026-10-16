import { createClient } from '@libsql/client';
import fs from 'fs';

// Usar variables de entorno para los secretos
const client = createClient({
  url: process.env.DATABASE_URL || 'libsql://runna-io-jpoves0.aws-eu-west-1.turso.io',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function runMigrations() {
  if (!process.env.TURSO_AUTH_TOKEN) {
    console.error('❌ Error: TURSO_AUTH_TOKEN environment variable is required');
    console.log('Set it with: export TURSO_AUTH_TOKEN=your_token_here');
    process.exit(1);
  }
  
  try {
    const sql = fs.readFileSync('./migrations/0000_empty_lyja.sql', 'utf-8');
    const statements = sql.split('--> statement-breakpoint\n').filter(s => s.trim());
    
    for (const statement of statements) {
      const trimmed = statement.trim();
      if (trimmed) {
        console.log('Executing:', trimmed.substring(0, 80) + '...');
        await client.execute(trimmed);
      }
    }
    
    console.log('✅ All migrations applied successfully!');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

runMigrations();
