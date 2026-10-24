import "dotenv/config";
const need = (k) => {
  if (!process.env[k]) throw new Error(`Missing env ${k}`);
  return process.env[k];
};
export const cfg = {
  port: process.env.PORT || 4000,
  databaseUrl: need("DATABASE_URL"),
  redisUrl: need("REDIS_URL"),
  clientId: need("HUBSPOT_CLIENT_ID"),
  clientSecret: need("HUBSPOT_CLIENT_SECRET"),
  redirectUri: need("HUBSPOT_REDIRECT_URI"),
  frontendUrl: need("FRONTEND_URL"),
  jwtSecret: need("JWT_SECRET"),
  encKey: Buffer.from(need("ENCRYPTION_KEY"), "hex"),
};
