export default ({ env }: any) => ({
  connection: {
    client: "postgres",
    connection: {
      host: env("DATABASE_HOST", "127.0.0.1"),
      port: env.int("DATABASE_PORT", 5432),
      database: env("DATABASE_NAME", "court_news"),
      user: env("DATABASE_USERNAME", "court_news"),
      password: env("DATABASE_PASSWORD"),
      ssl: env.bool("DATABASE_SSL", false)
        ? { rejectUnauthorized: true, ca: env("DATABASE_SSL_CA") }
        : false,
    },
    pool: { min: 0, max: env.int("DATABASE_POOL_MAX", 10) },
    acquireConnectionTimeout: 60000,
  },
  settings: { forceMigration: true, runMigrations: true },
});
