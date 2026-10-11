'use strict';
module.exports={async up(knex){
 if(!await knex.schema.hasTable('processing_jobs'))await knex.schema.createTable('processing_jobs',t=>{t.string('id').primary();t.string('source_id').notNullable().index();t.string('kind').notNullable();t.string('state').notNullable();t.integer('attempts').notNullable().defaultTo(0);t.string('lease_token');t.timestamp('lease_until',{useTz:true});t.jsonb('payload').notNullable();t.jsonb('result');t.text('error');t.string('requested_by').notNullable();t.string('article_id');t.timestamp('created_at',{useTz:true}).notNullable();t.timestamp('updated_at',{useTz:true}).notNullable();});
 await knex.raw("CREATE UNIQUE INDEX IF NOT EXISTS processing_active_job_idx ON processing_jobs(source_id,kind) WHERE state IN ('queued','running')");
 if(!await knex.schema.hasTable('article_versions'))await knex.schema.createTable('article_versions',t=>{t.bigIncrements('id');t.string('document_id').notNullable().index();t.jsonb('snapshot').notNullable();t.string('actor_id').notNullable();t.timestamp('created_at',{useTz:true}).notNullable();});
}};
