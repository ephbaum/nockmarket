// Process entry point: connects the database, builds the app, attaches
// Socket.IO, starts the simulator, and shuts all of it down in order.
//
// Replaces the bottom of nockmarket.js (lines 117-127), which called
// db.open() and app.listen() with no error handling and no shutdown path
// at all — the container had nothing to do on SIGTERM but be killed.
import { createServer } from 'node:http';

import config from './config.js';
import * as db from './db/client.js';
import * as users from './db/users.js';
import * as transactions from './db/transactions.js';
import { createQuoteProvider } from './quotes/index.js';
import { createSessionMiddleware } from './auth/session.js';
import { createApp } from './app.js';
import { createIo } from './realtime/io.js';
import { createSimulator } from './simulator/index.js';
import { buildMarketPayload } from './realtime/market.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

async function main() {
  await db.connect(config.mongoUri);
  await db.ensureIndexes();
  logger.info({ uri: redactUri(config.mongoUri) }, 'connected to mongodb');

  const quotes = createQuoteProvider(process.env);
  const sessionMiddleware = createSessionMiddleware(config, db.getClient());

  const app = createApp({
    config,
    db,
    users,
    transactions,
    quotes,
    sessionMiddleware,
    logger,
  });

  const httpServer = createServer(app);
  const realtime = createIo(httpServer, { sessionMiddleware, users, logger });

  // Logout must forcibly drop the user's sockets: the session is
  // snapshotted at handshake time, so an open socket does not otherwise
  // notice that it was destroyed.
  app.set('disconnectUser', realtime.disconnectUser);

  const simulator = createSimulator({
    symbols: config.simulator.symbols,
    minMs: config.simulator.minMs,
    maxMs: config.simulator.maxMs,
    sink: transactions,
    publish: realtime.publishMarket,
    logger,
  });

  // Seed the snapshot so the first client to connect sees a ladder
  // immediately rather than an empty table.
  for (const [symbol, book] of simulator.books) {
    realtime.marketState.update(buildMarketPayload(symbol, book));
  }

  if (config.simulator.enabled) {
    simulator.start();
    logger.info({ symbols: config.simulator.symbols }, 'simulator started');
  }

  await new Promise((resolve) => httpServer.listen(config.port, resolve));
  logger.info({ port: config.port, env: config.nodeEnv }, 'nockmarket listening');

  installShutdown({ simulator, realtime, httpServer });
}

/**
 * Ordered shutdown: stop generating work, stop accepting connections,
 * drain, then release the database. Getting this order wrong is what
 * makes containers hang for their full termination grace period.
 */
function installShutdown({ simulator, realtime, httpServer }) {
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const timeout = setTimeout(() => {
      logger.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, 10_000);
    timeout.unref();

    try {
      simulator.stop();
      await realtime.close();
      await new Promise((resolve) => httpServer.close(resolve));
      await db.close();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    logger.error({ err }, 'unhandled rejection');
  });
}

/** Never log credentials embedded in a connection string. */
function redactUri(uri) {
  return String(uri).replace(/\/\/[^@]*@/, '//***@');
}

main().catch((err) => {
  logger.error({ err }, 'failed to start');
  process.exit(1);
});
