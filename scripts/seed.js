#!/usr/bin/env node
// Seeds one demo user so the app is explorable immediately after
// `docker compose up` or `npm run dev`, without a manual signup first.
//
// Deliberately thin: it reuses the exact same repositories and password
// module the app itself uses (src/db/*.js, src/auth/password.js) rather
// than writing to Mongo or hashing a password itself. That is the whole
// point of this file — it cannot drift from what a real signup does,
// because it does not implement its own version of "create a user".
//
// Idempotent: DuplicateUserError from a second run (the unique index on
// usernameLower, see src/db/client.js#ensureIndexes) is treated as
// success, not a failure, so this is safe to run on every container
// start or as often as you like.
//
// Reads the same MONGODB_URI the app reads (src/config.js), so it talks
// to the same database `npm run dev` / `docker compose up` uses.
import * as db from '../src/db/client.js';
import * as users from '../src/db/users.js';
import { DuplicateUserError } from '../src/db/users.js';
import { hash } from '../src/auth/password.js';

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/nockmarket';

const DEMO_USERNAME = process.env.SEED_USERNAME ?? 'demo';
const DEMO_EMAIL = process.env.SEED_EMAIL ?? 'demo@example.com';
const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'demo-password-123';

async function main() {
  await db.connect(MONGODB_URI);
  await db.ensureIndexes();

  try {
    await users.create({
      username: DEMO_USERNAME,
      email: DEMO_EMAIL,
      passwordHash: await hash(DEMO_PASSWORD),
      passwordAlgo: 'scrypt',
    });
    console.log('Seeded demo user:');
  } catch (err) {
    if (err instanceof DuplicateUserError) {
      console.log('Demo user already exists (nothing to do). Sign in with:');
    } else {
      throw err;
    }
  }

  console.log(`  username: ${DEMO_USERNAME}`);
  console.log(`  password: ${DEMO_PASSWORD}`);
  console.log(`  url:      http://localhost:${process.env.PORT ?? 3000}/`);
  console.log(
    '\nOverride with SEED_USERNAME / SEED_EMAIL / SEED_PASSWORD env vars if you need a different demo account.'
  );

  await db.close();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exitCode = 1;
});
