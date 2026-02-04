import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.DATABASE_URL!,
  authToken: process.env.DATABASE_AUTH_TOKEN
});

async function run() {
  try {
    await db.execute('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
    console.log('Added email_verified column');
  } catch (e: any) {
    if (e.message?.includes('duplicate column')) {
      console.log('email_verified already exists');
    } else {
      console.error('Error adding email_verified:', e.message);
    }
  }

  try {
    await db.execute('ALTER TABLE users ADD COLUMN verification_code TEXT');
    console.log('Added verification_code column');
  } catch (e: any) {
    if (e.message?.includes('duplicate column')) {
      console.log('verification_code already exists');
    } else {
      console.error('Error adding verification_code:', e.message);
    }
  }

  try {
    await db.execute('ALTER TABLE users ADD COLUMN verification_code_expires_at TEXT');
    console.log('Added verification_code_expires_at column');
  } catch (e: any) {
    if (e.message?.includes('duplicate column')) {
      console.log('verification_code_expires_at already exists');
    } else {
      console.error('Error adding verification_code_expires_at:', e.message);
    }
  }

  console.log('Migration complete!');
}

run();
