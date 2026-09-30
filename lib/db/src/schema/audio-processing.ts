// Retained for compatibility with existing databases. The phone-only import
// flow no longer writes these tables. Removing them from the schema would
// schedule destructive drops during schema sync/publish.
import { pgTable, text, timestamp, jsonb, integer, real } from "drizzle-orm/pg-core";

export const audioAssets = pgTable("audio_assets", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  processingExpiresAt: timestamp("processing_expires_at", { withTimezone: true }).notNull(),
  playbackExpiresAt: timestamp("playback_expires_at", { withTimezone: true }),
  playbackBytes: integer("playback_bytes").notNull(),
  processingBytes: integer("processing_bytes").notNull(),
  sourceName: text("source_name"),
  sourceBytes: integer("source_bytes"),
});

export const alignmentJobs = pgTable("alignment_jobs", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  input: jsonb("input").notNull(),
  result: jsonb("result"),
  errorMessage: text("error_message"),
  progress: real("progress"),
  attempts: integer("attempts").notNull().default(0),
  leaseOwner: text("lease_owner"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});