const os = require('os');
const { app } = require('./app');
const { env } = require('./config/env');
const { prisma } = require('./config/prisma');

function getLanIpv4Address() {
  const networkInterfaces = os.networkInterfaces();

  for (const addresses of Object.values(networkInterfaces)) {
    for (const address of addresses ?? []) {
      if (address && address.family === 'IPv4' && !address.internal) {
        return address.address;
      }
    }
  }

  return null;
}

function buildServerUrls() {
  const lanIpv4Address = getLanIpv4Address();
  const localhostUrl = `http://localhost:${env.port}`;
  const lanUrl = lanIpv4Address ? `http://${lanIpv4Address}:${env.port}` : null;

  return {
    lanIpv4Address,
    lanUrl,
    localhostUrl
  };
}

const server = app.listen(env.port, env.host, () => {
  const { lanUrl, localhostUrl } = buildServerUrls();

  console.log(`GamePedia auth server listening on ${env.host}:${env.port}`);
  console.log(`Local URL: ${localhostUrl}`);
  console.log(`LAN URL: ${lanUrl ?? 'Unavailable (no external IPv4 interface detected)'}`);
});

async function shutdown(signal) {
  console.log(`${signal} received. Shutting down GamePedia auth server.`);

  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
