export default ({ env }: any) => ({
  cron: { enabled: true },
  host: env("HOST", "127.0.0.1"),
  port: env.int("PORT", 1337),
  url: env("CMS_PUBLIC_URL", "http://localhost:1337"),
  dirs: { public: env("MEDIA_PUBLIC_DIR", "./public") },
  app: { keys: env.array("APP_KEYS") },
  proxy: { koa: env.bool("TRUST_PROXY", false) },
});
