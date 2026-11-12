import { loadConfig } from '../config/env.js';

import { createDatabase } from './client.js';

/** `npm run db:migrate` — aplica as migrações pendentes em DATABASE_URL. */
const config = loadConfig();
const database = createDatabase(config.databaseUrl);
try {
  await database.migrate();
  process.stdout.write(`Migrações aplicadas (${database.kind}).\n`);
} finally {
  await database.close();
}
