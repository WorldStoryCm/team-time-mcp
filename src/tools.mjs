import * as z from 'zod/v4';
import { randomUUID } from 'node:crypto';
import { TeamTimeError } from './api.mjs';
import { coordinationTools } from './coordination-tools.mjs';

const id = z.string().min(1).max(200);
const resourceId = id.regex(/^[A-Za-z0-9_-]+$/);
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(5000);
const date = z.iso.date().nullable();
const tags = z.array(z.string().min(1).max(60)).max(10);
const paging = { limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(4000).optional() };
const ownedTask = { taskId: resourceId, expectedVersion: version, claimId: z.uuid().optional() };
const prefix = '<!-- team-time-mcp-claim:';
const suffix = ' -->';

export function parseClaim(description) {
  const start = description.indexOf(prefix);
  if (start < 0) return null;
  const end = description.indexOf(suffix, start);
  try {
    if (end < 0 || description.indexOf(prefix, start + prefix.length) >= 0) throw new Error();
    const claim = JSON.parse(description.slice(start + prefix.length, end));
    if (!z.uuid().safeParse(claim.id).success || typeof claim.agentId !== 'string' || typeof claim.claimedAt !== 'string') throw new Error();
    return { ...claim, start, end: end + suffix.length };
  } catch { throw new TeamTimeError('invalid_claim', 'Task claim metadata is malformed; inspect the task manually before changing it.'); }
}

function marker(claim) {
  return `${prefix}${JSON.stringify({ id: claim.id, agentId: claim.agentId, claimedAt: claim.claimedAt })}${suffix}`;
}

export function createTools(api) {
  const definitions = [];
  function add(name, description, shape, readOnly, run) {
    definitions.push({ name: `team_time_${name}`, description,
      schema: z.strictObject(shape), readOnly, run });
  }
  async function current(args) {
    const { data: task } = await api.read('getTask', `/tasks/${args.taskId}`);
    if (task.version !== args.expectedVersion) {
      throw new TeamTimeError('stale_version', 'Task changed since the supplied version. Read it again and reconsider.', { currentVersion: task.version });
    }
    const claim = parseClaim(task.description);
    if (claim && claim.id !== args.claimId) {
      throw new TeamTimeError('task_claimed', 'Task is held by another agent run. Do not start or modify this work.', { agentId: claim.agentId });
    }
    if (!claim && args.claimId) throw new TeamTimeError('claim_missing', 'The claim was removed or replaced; stop and inspect the task.');
    return { task, claim };
  }

  add('context', 'Confirm the organization, key access target, identity, and allowed operation IDs.', {}, true, () => api.context());
  add('bootstrap', 'Start here: context, then all permitted projects, members, workflow, and tags. Names may be ambiguous; use returned IDs. assigneeId is member.userId.', {}, true, async () => {
    const { data: context } = await api.context();
    const result = { context };
    for (const [name, operation, path, collection] of [
      ['projects', 'listProjects', '/projects', true], ['members', 'listMembers', '/members', true],
      ['workflow', 'getWorkflow', '/workflow', false], ['tags', 'listTags', '/tags', true]
    ]) {
      result[name] = context.operations.includes(operation) ?
        collection ? await api.all(operation, path) : (await api.read(operation, path)).data : { unavailable: true };
    }
    return result;
  });
  for (const [name, operation, path] of [
    ['projects', 'listProjects', '/projects'], ['members', 'listMembers', '/members'], ['tags', 'listTags', '/tags']
  ]) add(`list_${name}`, `Read one page of ${name}. Follow page.nextCursor with the same limit.`, paging, true, args => api.read(operation, path, args));
  add('workflow', 'Read status IDs, categories, and workflow version before changing task status.', {}, true, () => api.read('getWorkflow', '/workflow'));
  add('list_tasks', 'Search tasks, including completed history. For coordination, inspect ALL unfinished project tasks and claim markers; title search alone can miss overlapping work. Follow every cursor with unchanged filters.', {
    ...paging, query: z.string().max(200).optional(), projectId: id.optional(), clientId: id.optional(),
    assigneeId: id.optional(), statusId: id.optional(), statusCategory: z.enum(['not_started', 'in_progress', 'completed']).optional(),
    dueFrom: z.iso.date().optional(), dueTo: z.iso.date().optional(), tagIds: z.array(id).max(10).optional()
  }, true, args => api.read('listTasks', '/tasks', args));
  add('get_task', 'Read the task and version. Inspect description for a team-time-mcp claim before starting work.', { taskId: resourceId }, true,
    args => api.read('getTask', `/tasks/${args.taskId}`));
  add('create_task', 'Create unfinished work after checking for overlapping tasks. Resolve IDs with bootstrap. Tags are names; assigneeId is a userId. Creation cannot atomically deduplicate competing agents.', {
    title: z.string().min(1).max(200), projectId: id, description: text.optional(),
    assigneeId: id.nullable().optional(), dueOn: date.optional(), tags: tags.optional(), statusId: id.optional()
  }, false, async args => {
    if (args.description?.includes(prefix)) throw new TeamTimeError('reserved_metadata', 'Use claim_task to create claim metadata.');
    return api.mutate('createTask', 'POST', '/tasks', args);
  });
  add('claim_task', 'Claim one existing not-started task using its observed version. agentId must identify this unique chat/run. A competing claim loses the version race. Refuses existing claims and in-progress/completed work. This records ownership; change status separately before editing code.', {
    taskId: resourceId, expectedVersion: version, agentId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_:/.-]+$/)
  }, false, async args => {
    const { task } = await current(args);
    if (task.statusCategory !== 'not_started') throw new TeamTimeError('task_unavailable', 'Only an unclaimed not-started task can be claimed.');
    const claim = { id: randomUUID(), agentId: args.agentId, claimedAt: new Date().toISOString() };
    const description = `${task.description}\n\n${marker(claim)}`;
    if (description.length > 5000) throw new TeamTimeError('description_too_long', 'Task description has no room for claim metadata.');
    const response = await api.mutate('updateTask', 'PATCH', `/tasks/${args.taskId}`, { expectedVersion: args.expectedVersion, description });
    return { ...response, claim, next: 'Keep claim.id. Use set_status with the new task version and claimId to move into progress before starting work.' };
  });
  add('update_task', 'Update only supplied fields after reading the task. Omitted fields stay unchanged; null clears assignee/due date; [] clears tags. Supply claimId for claimed work. Put progress/checkpoints in result, preserving previous checkpoints when useful.', {
    ...ownedTask, title: z.string().min(1).max(200).optional(), projectId: id.optional(),
    assigneeId: id.nullable().optional(), dueOn: date.optional(), description: text.optional(), result: text.optional(), tags: tags.optional()
  }, false, async args => {
    const { claim } = await current(args);
    const { taskId, claimId, ...body } = args;
    if (body.description !== undefined) {
      if (body.description.includes(prefix)) throw new TeamTimeError('reserved_metadata', 'Pass description without claim metadata; the server preserves it.');
      if (claim) body.description += `\n\n${marker(claim)}`;
      if (body.description.length > 5000) throw new TeamTimeError('description_too_long', 'Description plus claim metadata exceeds 5000 characters.');
    }
    return api.mutate('updateTask', 'PATCH', `/tasks/${taskId}`, body);
  });
  add('set_status', 'Move to a discovered workflow status using observed task and workflow versions. Include claimId if claimed. Never automatically overwrite a stale version. Completion may stop the key creator’s matching timer.', {
    ...ownedTask, statusId: id, expectedWorkflowVersion: version, result: text.optional()
  }, false, async args => {
    await current(args);
    const { data: workflow } = await api.read('getWorkflow', '/workflow');
    if (workflow.version !== args.expectedWorkflowVersion) throw new TeamTimeError('stale_version', 'Workflow changed. Read it again before selecting a status.');
    if (!workflow.statuses.some(status => status.id === args.statusId)) throw new TeamTimeError('invalid_status', 'Status is absent from the discovered workflow.');
    const { taskId, claimId, ...body } = args;
    return api.mutate('changeTaskStatus', 'POST', `/tasks/${taskId}/status`, body);
  });
  add('complete_task', 'Complete verified work and record its outcome, test evidence, and relevant links. Include claimId for claimed work. May atomically stop the key creator’s matching timer; other members’ timers can block completion.', {
    ...ownedTask, result: text.optional()
  }, false, async args => {
    await current(args);
    const { taskId, claimId, ...body } = args;
    return api.mutate('completeTask', 'POST', `/tasks/${taskId}/complete`, body);
  });
  add('release_claim', 'Release this run’s claim after completing or handing off work. For handoff, save a checkpoint and set a not-started status first. Never release another run’s claim automatically.', {
    taskId: resourceId, expectedVersion: version, claimId: z.uuid()
  }, false, async args => {
    const { task, claim } = await current(args);
    if (task.statusCategory === 'in_progress') throw new TeamTimeError('task_in_progress', 'Save a checkpoint and move to not-started, or complete the task, before releasing.');
    let description = task.description.slice(0, claim.start) + task.description.slice(claim.end);
    if (task.description.slice(Math.max(0, claim.start - 2), claim.start) === '\n\n') {
      description = task.description.slice(0, claim.start - 2) + task.description.slice(claim.end);
    }
    return api.mutate('updateTask', 'PATCH', `/tasks/${args.taskId}`, { expectedVersion: args.expectedVersion, description });
  });
  add('pending_commands', 'Recover uncertain mutations after a timeout or process restart. Retained seven days; returns command IDs without payloads. Retry the exact command instead of creating another task.', {}, true,
    async () => ({ commands: await api.store.pending() }));
  add('retry_command', 'Replay a retained mutation with its original UUID, method, path, and payload. Use after an uncertain response. Does not rebase stale versions. Rechecks credential access.', {
    commandId: z.uuid()
  }, false, args => api.retry(args.commandId));
  return [...definitions, ...coordinationTools(api)];
}
