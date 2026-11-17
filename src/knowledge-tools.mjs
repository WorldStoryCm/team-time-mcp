import * as z from 'zod/v4';
import { contracts as k } from './knowledge/ledger.mjs';

const projectId = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/)
  .max(200);
const project = z.strictObject({ projectId });
export function knowledgeTools(api) {
  function tool(name, operation, schema, description, readOnly, run) {
    return {
      name: 'team_time_knowledge_' + name,
      operation,
      schema,
      description,
      readOnly,
      run: ({ projectId, ...rest }) =>
        run('/projects/' + projectId + '/knowledge', rest)
    };
  }
  return [
    tool(
      'search',
      'listKnowledge',
      project.extend(k.listQuery.shape),
      'Search accepted project knowledge. Use view=review to inspect pending or resolved proposals. Follow data.nextCursor.',
      true,
      (path, args) => api.read('listKnowledge', path, args)
    ),
    tool(
      'note',
      'getKnowledgeNote',
      project.extend({ noteId: z.uuid() }),
      'Read the current note, its source evidence, and every earlier revision. Use this before relying on or merging a note.',
      true,
      (path, { noteId }) =>
        api.read('getKnowledgeNote', path + '/notes/' + noteId)
    ),
    tool(
      'proposal',
      'getKnowledgeProposal',
      project.extend({ proposalId: z.uuid() }),
      'Read original wording, evidence, checked references and review outcome.',
      true,
      (path, { proposalId }) =>
        api.read('getKnowledgeProposal', path + '/proposals/' + proposalId)
    ),
    tool(
      'check',
      'checkKnowledge',
      project.extend({ proposalId: z.uuid() }),
      'Collect the proposal and current target, cited notes, same-title and overlapping-text candidates. Compare their actual sources to decide whether claims conflict; search synonymous terms when needed.',
      true,
      (path, { proposalId }) =>
        api.read('checkKnowledge', path + '/proposals/' + proposalId + '/check')
    ),
    tool(
      'propose',
      'proposeKnowledge',
      project.extend(k.submission.shape),
      'Propose one durable finding with a verifiable source. Identify the target revision for updates. Cite related, duplicate or contradictory notes and explain each link.',
      false,
      (path, args) =>
        api.mutate('proposeKnowledge', 'POST', path + '/proposals', args)
    ),
    tool(
      'review',
      'reviewKnowledge',
      project.extend({ proposalId: z.uuid(), ...k.review.shape }),
      'Compare both sources before deciding. Approve supported findings, merge duplicates using the full resolved text and target revision, reject unsupported claims and record why. Leave uncertain contradictions pending.',
      false,
      (path, { proposalId, ...args }) =>
        api.mutate(
          'reviewKnowledge',
          'POST',
          path + '/proposals/' + proposalId + '/decision',
          args
        )
    )
  ];
}
