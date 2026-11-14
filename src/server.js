// Runs the app on your own computer: npm start
import { PORT } from './config.js';
import { app } from './app.js';
import { loadSettings } from './db.js';
import { getBranding } from './settings.js';

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

app.listen(PORT, async () => {
  await loadSettings().catch(() => {});
  console.log(`\n  ${getBranding().appName} is running. Open http://localhost:${PORT} in your browser.\n`);
});
