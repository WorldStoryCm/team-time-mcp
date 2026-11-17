CREATE TABLE IF NOT EXISTS local_project (slot INTEGER PRIMARY KEY CHECK (slot=1), id TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS local_task (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS local_tag (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS local_receipt (id TEXT PRIMARY KEY, payload TEXT NOT NULL, result TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS "knowledge_record" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL REFERENCES local_project(id),
	"title" text NOT NULL,
	"category" text NOT NULL,
	"content" text NOT NULL,
	"evidence" text NOT NULL,
	"author" text NOT NULL,
	"created_at" text NOT NULL,
	"target" text,
	"links" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"note_id" text,
	"revision" integer,
	"published_content" text,
	"reviewer" text,
	"reason" text,
	"reviewed_at" text,
	CONSTRAINT "knowledge_record_state" CHECK (("knowledge_record"."status" = 'pending' AND "knowledge_record"."reviewer" IS NULL OR "knowledge_record"."status" IN ('approved','merged','rejected') AND "knowledge_record"."reviewer" IS NOT NULL) AND (("knowledge_record"."status" IN ('approved','merged')) = ("knowledge_record"."note_id" IS NOT NULL AND "knowledge_record"."revision" IS NOT NULL AND "knowledge_record"."published_content" IS NOT NULL)))
);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_project_revision ON knowledge_record(project_id,note_id,revision);
CREATE INDEX IF NOT EXISTS knowledge_project_status ON knowledge_record(project_id,status,id);
