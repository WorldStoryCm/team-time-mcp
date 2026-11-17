// Generated from Team Time src/features/knowledge/contracts.ts by export-knowledge-mcp.mts.
import { z } from "zod/v4";
export const category = z.enum([
    "decision",
    "fact",
    "constraint",
    "question",
    "summary",
]);
const short = z.string().trim().min(1).max(160);
const body = z.string().trim().min(1).max(5000);
export const reference = z.strictObject({
    noteId: z.uuid(),
    revision: z.int().positive(),
});
export const link = reference.extend({
    relation: z.enum(["related", "duplicates", "contradicts"]),
    reason: z.string().trim().min(1).max(500),
});
export const submission = z.strictObject({
    title: short,
    category,
    content: body,
    evidence: z.string().trim().min(1).max(2000),
    target: reference.optional(),
    links: z.array(link).max(12).default([]),
});
export const review = z.strictObject({
    action: z.enum(["approve", "merge", "reject"]),
    reason: z.string().trim().min(1).max(2000),
    target: reference.optional(),
    mergedContent: body.optional(),
});
export const status = z.enum(["pending", "approved", "merged", "rejected"]);
export const listQuery = z.strictObject({
    view: z.enum(["notes", "review"]).default("notes"),
    query: z.string().trim().max(200).default(""),
    status: status.optional(),
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(40),
});
export const record = z.object({
    id: z.uuid(),
    projectId: z.string(),
    title: short,
    category,
    content: body,
    evidence: z.string(),
    author: z.string(),
    createdAt: z.string(),
    target: reference.nullable(),
    links: z.array(link),
    status,
    noteId: z.uuid().nullable(),
    revision: z.number().nullable(),
    publishedContent: z.string().nullable(),
    reviewer: z.string().nullable(),
    reason: z.string().nullable(),
    reviewedAt: z.string().nullable(),
});
export const page = z.object({
    items: z.array(record),
    nextCursor: z.string().nullable(),
});
export const comparison = z.object({
    proposal: record,
    candidates: z.array(z.object({
        basis: z.enum(["target", "cited", "same_title", "text_match"]),
        note: record,
    })),
});
export const detail = z.object({ current: record, history: z.array(record) });
