// Generated from Team Time src/server/knowledge/ledger.ts by export-knowledge-mcp.mts.
// The cloud and embedded stores run this code inside a transaction serialized on project writes.
import { randomUUID } from "node:crypto";
import * as k from "./contracts.mjs";
export { k as contracts };
export class KnowledgeError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
const missing = () => new KnowledgeError("resource_not_found", "This project knowledge record is unavailable.");
const invalid = (message) => new KnowledgeError("validation_failed", message);
const stale = () => new KnowledgeError("stale_version", "Knowledge changed. Read the current note and proposal before deciding again.");
function decode(row) {
    return k.record.parse({
        ...row,
        projectId: row.project_id,
        createdAt: row.created_at,
        reviewedAt: row.reviewed_at,
        noteId: row.note_id,
        publishedContent: row.published_content,
        target: row.target ? JSON.parse(String(row.target)) : null,
        links: JSON.parse(String(row.links)),
    });
}
const latest = "r.note_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM knowledge_record n WHERE n.project_id=r.project_id AND n.note_id=r.note_id AND n.revision>r.revision)";
export function knowledgeLedger(query, projectId, actor) {
    async function getProposal(id) {
        const [row] = await query("SELECT * FROM knowledge_record WHERE project_id=? AND id=?", [projectId, id]);
        if (!row)
            throw missing();
        return decode(row);
    }
    async function current(ref) {
        const [row] = await query("SELECT * FROM knowledge_record WHERE project_id=? AND note_id=? ORDER BY revision DESC LIMIT 1", [projectId, ref.noteId]);
        if (!row)
            throw missing();
        const note = decode(row);
        if (note.revision !== ref.revision)
            throw stale();
        return note;
    }
    async function list(input) {
        const opts = k.listQuery.parse(input);
        const clauses = ["r.project_id=?"];
        const params = [projectId];
        if (opts.view === "notes")
            clauses.push(latest);
        else {
            clauses.push("r.status=?");
            params.push(opts.status ?? "pending");
        }
        if (opts.cursor) {
            clauses.push("r.id>?");
            params.push(opts.cursor);
        }
        for (const word of opts.query.toLowerCase().split(/\s+/).filter(Boolean)) {
            clauses.push("lower(r.title || ' ' || r.category || ' ' || coalesce(r.published_content,r.content) || ' ' || r.evidence) LIKE ? ESCAPE '!'");
            params.push("%" + word.replace(/[!%_]/g, "!$&") + "%");
        }
        params.push(opts.limit + 1);
        const rows = await query("SELECT r.* FROM knowledge_record r WHERE " +
            clauses.join(" AND ") +
            " ORDER BY r.id LIMIT ?", params);
        const items = rows.slice(0, opts.limit).map(decode);
        return {
            items,
            nextCursor: rows.length > opts.limit ? items[items.length - 1].id : null,
        };
    }
    async function getNote(noteId) {
        const rows = await query("SELECT * FROM knowledge_record WHERE project_id=? AND note_id=? ORDER BY revision DESC", [projectId, noteId]);
        if (!rows.length)
            throw missing();
        const history = rows.map(decode);
        return { current: history[0], history };
    }
    async function check(id) {
        const proposal = await getProposal(id);
        const candidates = [];
        const seen = new Set();
        const add = (note, basis) => {
            if (note.noteId && !seen.has(note.noteId)) {
                candidates.push({ basis, note });
                seen.add(note.noteId);
            }
        };
        const refs = [
            ...(proposal.target ? [proposal.target] : []),
            ...proposal.links,
        ];
        for (const ref of refs) {
            if (seen.has(ref.noteId))
                continue;
            const rows = await query("SELECT * FROM knowledge_record WHERE project_id=? AND note_id=? ORDER BY revision DESC LIMIT 1", [projectId, ref.noteId]);
            if (rows.length)
                add(decode(rows[0]), ref.noteId === proposal.target?.noteId ? "target" : "cited");
        }
        const exact = await query("SELECT r.* FROM knowledge_record r WHERE r.project_id=? AND " +
            latest +
            " AND lower(r.title)=lower(?) LIMIT 1", [projectId, proposal.title]);
        if (exact.length)
            add(decode(exact[0]), "same_title");
        // Term overlap surfaces candidates for the reviewing model to compare with evidence.
        const words = [
            ...new Set(proposal.title.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []),
        ].slice(0, 8);
        if (words.length) {
            const rank = words
                .map(() => "CASE WHEN lower(r.title || ' ' || r.published_content) LIKE ? THEN 1 ELSE 0 END")
                .join(" + ");
            const rows = await query("SELECT * FROM (SELECT r.*, (" +
                rank +
                ") AS score FROM knowledge_record r WHERE r.project_id=? AND " +
                latest +
                ") matches WHERE score>0 ORDER BY score DESC, id LIMIT 12", [...words.map((word) => "%" + word + "%"), projectId]);
            for (const row of rows)
                add(decode(row), "text_match");
        }
        return { proposal, candidates };
    }
    async function propose(raw) {
        const input = k.submission.parse(raw);
        if (input.target)
            await current(input.target);
        for (const ref of input.links)
            await current(ref);
        const id = randomUUID();
        await query("INSERT INTO knowledge_record (id,project_id,title,category,content,evidence,author,created_at,target,links) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id", [
            id,
            projectId,
            input.title,
            input.category,
            input.content,
            input.evidence,
            actor,
            new Date().toISOString(),
            input.target ? JSON.stringify(input.target) : null,
            JSON.stringify(input.links),
        ]);
        return getProposal(id);
    }
    async function decide(id, raw) {
        const input = k.review.parse(raw);
        const proposal = await getProposal(id);
        if (proposal.status !== "pending")
            throw stale();
        const merging = input.action === "merge";
        if (merging !== Boolean(input.mergedContent) || (!merging && input.target))
            throw invalid("Supply the merged text and a destination revision only for a merge.");
        let noteId = null, revision = null, published = null;
        if (input.action !== "reject") {
            const target = input.target ?? proposal.target;
            if (merging && !target)
                throw invalid("Select an existing note and revision to merge into.");
            if (proposal.target && target?.noteId !== proposal.target.noteId)
                throw invalid("Review the original target or submit a new proposal.");
            // An explicit merge can rebase onto a newly read revision of the same note.
            if (target)
                await current(target);
            for (const ref of proposal.links) {
                if (ref.noteId !== target?.noteId)
                    await current(ref);
            }
            const duplicates = await query("SELECT r.note_id FROM knowledge_record r WHERE r.project_id=? AND " +
                latest +
                " AND lower(r.title)=lower(?) AND r.note_id<>? LIMIT 1", [projectId, proposal.title, target?.noteId ?? ""]);
            if (duplicates.length)
                throw invalid("A different current note has this title. Compare it and merge or reject this proposal.");
            noteId = target?.noteId ?? id;
            revision = (target?.revision ?? 0) + 1;
            published = merging ? input.mergedContent : proposal.content;
        }
        const state = { approve: "approved", merge: "merged", reject: "rejected" }[input.action];
        const updated = await query("UPDATE knowledge_record SET status=?,note_id=?,revision=?,published_content=?,reviewer=?,reason=?,reviewed_at=? WHERE project_id=? AND id=? AND status='pending' RETURNING *", [
            state,
            noteId,
            revision,
            published,
            actor,
            input.reason,
            new Date().toISOString(),
            projectId,
            id,
        ]);
        if (!updated.length)
            throw stale();
        return decode(updated[0]);
    }
    return { list, getNote, getProposal, check, propose, decide };
}
