"use strict";
module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable("worker_power_state")))
      await knex.schema.createTable("worker_power_state", (t) => {
        t.integer("id").primary();
        t.string("mode").notNullable().defaultTo("active");
        t.timestamp("idle_since", { useTz: true }).nullable();
      });
    await knex("worker_power_state").insert({ id: 1, mode: "active" }).onConflict("id").ignore();
  },
};
