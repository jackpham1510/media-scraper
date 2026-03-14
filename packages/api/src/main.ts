import Fastify from 'fastify';
import { parseEnv } from './config/env.js';
import { healthRoutes } from './routes/health.js';

const env = parseEnv();

const app = Fastify({
  logger: {
    level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  },
});

await app.register(healthRoutes);

const address = await app.listen({ port: env.PORT, host: '0.0.0.0' });
app.log.info(`Server listening at ${address}`);
