const { compileStrapi, createStrapi } = require("@strapi/strapi");
(async () => {
  const context = await compileStrapi();
  const app = await createStrapi(context).load();
  console.log(
    "Strapi migrations, schema synchronization and indexes completed.",
  );
  await app.destroy();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
