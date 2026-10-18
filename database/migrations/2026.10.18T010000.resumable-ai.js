"use strict";
module.exports = {
  async up(knex) {
    for (const [name, add] of [
      ["checkpoint", (t) => t.jsonb("checkpoint")],
      ["progress", (t) => t.jsonb("progress")],
      [
        "next_run_at",
        (t) => t.timestamp("next_run_at", { useTz: true }).index(),
      ],
      [
        "lease_failures",
        (t) => t.integer("lease_failures").notNullable().defaultTo(0),
      ],
    ])
      if (!(await knex.schema.hasColumn("processing_jobs", name)))
        await knex.schema.alterTable("processing_jobs", add);
    await knex.raw("DROP INDEX IF EXISTS processing_active_job_idx");
    await knex.raw(
      "CREATE UNIQUE INDEX processing_active_job_idx ON processing_jobs(source_id,kind) WHERE state IN ('queued','running','waiting')",
    );
    if (!(await knex.schema.hasTable("ai_provider_credentials")))
      await knex.schema.createTable("ai_provider_credentials", (t) => {
        t.string("id").primary();
        t.string("provider").notNullable();
        t.string("label").notNullable();
        t.string("model").notNullable();
        t.text("encrypted_key").notNullable();
        t.string("key_hint").notNullable();
        t.boolean("enabled").notNullable().defaultTo(true);
        t.integer("priority").notNullable().defaultTo(10);
        t.decimal("input_price", 16, 8);
        t.decimal("output_price", 16, 8);
        t.timestamp("cooldown_until", { useTz: true });
        t.timestamp("created_at", { useTz: true }).notNullable();
        t.timestamp("updated_at", { useTz: true }).notNullable();
      });
    if (!(await knex.schema.hasTable("ai_provider_settings")))
      await knex.schema.createTable("ai_provider_settings", (t) => {
        t.integer("id").primary();
        t.boolean("managed").notNullable().defaultTo(false);
      });
    await knex("ai_provider_settings")
      .insert({ id: 1, managed: false })
      .onConflict("id")
      .ignore();
  },
};
