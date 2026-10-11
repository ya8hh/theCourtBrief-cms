export default ({ env }: any) => ({
  auth: {
    secret: env("ADMIN_JWT_SECRET"),
    sessions: {
      accessTokenLifespan: 28800,
      maxSessionLifespan: 28800,
      maxRefreshTokenLifespan: 28800,
    },
  },
  apiToken: { salt: env("API_TOKEN_SALT") },
  transfer: { token: { salt: env("TRANSFER_TOKEN_SALT") } },
  secrets: { encryptionKey: env("ENCRYPTION_KEY") },
  flags: { nps: false, promoteEE: false },
});
