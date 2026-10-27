import { startServer } from './server.ts';
import { startScheduler } from './scheduler.ts';

const server = await startServer();
startScheduler();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
