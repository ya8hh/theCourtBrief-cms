"use strict";
module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable("editorial_audit_events")))
      await knex.schema.createTable("editorial_audit_events", (t) => {
        t.bigIncrements("id");
        t.string("document_id").notNullable().index();
        t.string("action").notNullable();
        t.string("actor_id").notNullable();
        t.timestamp("occurred_at", { useTz: true }).notNullable();
      });
  },
};
