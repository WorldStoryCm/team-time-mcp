import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TeamTimeClient } from '../src/api.mjs';
import { createTools, parseClaim } from '../src/tools.mjs';
import { createServer } from '../src/index.mjs';

const key = 'test-credential-do-not-use';
const operations = ['listProjects', 'listMembers', 'getWorkflow', 'listTags', 'listTasks', 'getTask',
  'createTask', 'updateTask', 'changeTaskStatus', 'completeTask'];
const initialTask = { id: 'task-1', projectId: 'project-1', title: 'Fix preview', description: 'Keep these requirements.\n',
  assigneeId: 'user-1', dueOn: '2026-11-01', tags: [{ id: 'tag-1', name: 'Bug' }], version: 1,
  statusCategory: 'not_started', statusId: 'todo', result: '' };

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'team-time-mcp-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = { task: structuredClone(initialTask), requests: [], receipts: new Map(), writes: 0,
    workflow: { version: 4, statuses: [{ id: 'todo', category: 'not_started' },
      { id: 'doing', category: 'in_progress' }, { id: 'done', category: 'completed' }] }, ...options };
  const json = (data, status = 200, headers) => new Response(JSON.stringify(data), { status, headers });
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers.Authorization, `Bearer ${key}`);
    assert.equal(init.redirect, 'error');
    assert.ok(!String(url).includes(key));
    const path = url.pathname.replace('/api/v1', '');
    state.requests.push({ path, method: init.method, body: init.body, commandId: init.headers['Idempotency-Key'], query: url.search });
    if (path === '/context') return json({ data: { organization: { id: state.organization ?? 'org-1' }, userId: 'user-1',
      operations: state.operations ?? operations, access: { type: state.access ?? 'organization', projectId: null } } });
    if (init.method === 'GET') {
      if (path === '/tasks/task-1') return json({ data: structuredClone(state.task) });
      if (path === '/workflow') return json({ data: state.workflow });
      if (path === '/projects') return json({ data: [{ id: url.searchParams.has('cursor') ? 'project-2' : 'project-1', name: 'Handinly' }],
        page: { nextCursor: url.searchParams.has('cursor') ? null : 'next-page' } });
      if (path === '/members') return json({ data: [{ id: 'membership-1', userId: 'user-1', name: 'Owner' }], page: { nextCursor: null } });
      if (path === '/tags' || path === '/tasks') return json({ data: path === '/tasks' ? [state.task] : [], page: { nextCursor: null } });
      throw new Error(`Unexpected GET ${path}`);
    }
    const commandId = init.headers['Idempotency-Key'];
    assert.match(commandId, /^[0-9a-f-]{36}$/);
    assert.equal(init.headers['Content-Type'], 'application/json');
    const body = JSON.parse(init.body);
    if (state.rateLimit) return json({ error: { code: 'rate_limited', message: 'Slow down' } }, 429, { 'Retry-After': '60' });
    const receipt = state.receipts.get(commandId);
    if (receipt) {
      assert.equal(receipt.body, init.body);
      assert.equal(receipt.path, path);
      if (state.loseResponses) throw new Error(`network failure ${key}`);
      return json(receipt.response);
    }
    if (body.expectedVersion !== undefined && (state.remoteStale || body.expectedVersion !== state.task.version)) {
      return json({ error: { code: 'stale_version', message: 'Changed' } }, 409);
    }
    state.writes++;
    if (path === '/tasks') state.task = { ...initialTask, ...body };
    else if (path.endsWith('/status')) {
      state.task.statusId = body.statusId;
      state.task.statusCategory = state.workflow.statuses.find(s => s.id === body.statusId).category;
      if (body.result !== undefined) state.task.result = body.result;
    } else if (path.endsWith('/complete')) {
      state.task.statusCategory = 'completed';
      if (body.result !== undefined) state.task.result = body.result;
    } else {
      const { expectedVersion, ...patch } = body;
      Object.assign(state.task, patch);
    }
    state.task.version++;
    const response = { data: structuredClone(state.task) };
    state.receipts.set(commandId, { body: init.body, path, response });
    if (state.loseResponses) throw new Error(`network failure ${key}`);
    return json(response);
  };
  const clientOptions = { apiKey: key, organizationId: 'org-1', stateDirectory: directory, fetchImpl, sleep: async () => {} };
  const api = new TeamTimeClient(clientOptions);
  const tools = createTools(api);
  const run = (name, args = {}) => {
    const tool = tools.find(tool => tool.name === `team_time_${name}`);
    return tool.run(tool.schema.parse(args));
  };
  return { api, state, run, directory, clientOptions };
}

test('bootstrap confirms organization before sequential discovery, follows pages, preserves member user IDs', async t => {
  const { run, state } = await fixture(t);
  const result = await run('bootstrap');
  assert.deepEqual(state.requests.map(r => r.path), ['/context', '/projects', '/projects', '/members', '/workflow', '/tags']);
  assert.equal(result.projects.length, 2);
  assert.equal(result.members[0].userId, 'user-1');
  assert.equal(result.members[0].id, 'membership-1');
  assert.match(state.requests[2].query, /limit=100/);
});

test('wrong organization fails closed before reading resources or mutating', async t => {
  const { run, state } = await fixture(t, { organization: 'different-org' });
  await assert.rejects(run('create_task', { projectId: 'project-1', title: 'New work' }), { code: 'organization_mismatch' });
  assert.deepEqual(state.requests.map(r => r.path), ['/context']);
  assert.equal(state.writes, 0);
});

test('project-scoped or limited key advertises unavailable discovery and cannot call disallowed operations', async t => {
  const { run, state } = await fixture(t, { access: 'project', operations: ['listProjects'] });
  const result = await run('bootstrap');
  assert.deepEqual(result.members, { unavailable: true });
  await assert.rejects(run('create_task', { projectId: 'project-1', title: 'New work' }), { code: 'operation_not_allowed' });
  assert.equal(state.writes, 0);
});

test('competing agents can claim a canonical task only once', async t => {
  const { run, state } = await fixture(t);
  const results = await Promise.allSettled([
    run('claim_task', { taskId: 'task-1', expectedVersion: 1, agentId: 'chat-a' }),
    run('claim_task', { taskId: 'task-1', expectedVersion: 1, agentId: 'chat-b' })
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'stale_version');
  assert.equal(state.writes, 1);
  assert.ok(parseClaim(state.task.description));
  assert.ok(state.task.description.startsWith(initialTask.description));
});

test('another run cannot update, complete, or acquire claimed work', async t => {
  const { run, state } = await fixture(t);
  await run('claim_task', { taskId: 'task-1', expectedVersion: 1, agentId: 'chat-a' });
  for (const name of ['update_task', 'complete_task', 'claim_task']) {
    await assert.rejects(run(name, { taskId: 'task-1', expectedVersion: state.task.version,
      ...(name === 'claim_task' ? { agentId: 'chat-b' } : {}) }), { code: 'task_claimed' });
  }
  assert.equal(state.writes, 1);
});

test('claim, status, checkpoint, completion, and release preserve unrelated fields and original description', async t => {
  const { run, state } = await fixture(t);
  const { claim } = await run('claim_task', { taskId: 'task-1', expectedVersion: 1, agentId: 'chat-a' });
  const args = () => ({ taskId: 'task-1', expectedVersion: state.task.version, claimId: claim.id });
  await run('set_status', { ...args(), statusId: 'doing', expectedWorkflowVersion: 4 });
  await assert.rejects(run('release_claim', args()), { code: 'task_in_progress' });
  await run('update_task', { ...args(), result: 'Implemented; verification running.' });
  const patch = JSON.parse(state.requests.filter(r => r.method === 'PATCH').at(-1).body);
  assert.deepEqual(Object.keys(patch).sort(), ['expectedVersion', 'result']);
  assert.equal(state.task.dueOn, initialTask.dueOn);
  assert.equal(state.task.assigneeId, initialTask.assigneeId);
  assert.deepEqual(state.task.tags, initialTask.tags);
  await run('complete_task', { ...args(), result: 'Verified: all relevant tests pass.' });
  await run('release_claim', args());
  assert.equal(state.task.description, initialTask.description);
  assert.equal(state.task.statusCategory, 'completed');
});

test('null clears fields, omitted fields and claim metadata survive a description update', async t => {
  const { run, state } = await fixture(t);
  const { claim } = await run('claim_task', { taskId: 'task-1', expectedVersion: 1, agentId: 'chat-a' });
  await run('update_task', { taskId: 'task-1', expectedVersion: 2, claimId: claim.id,
    assigneeId: null, dueOn: null, tags: [], description: 'Revised requirements' });
  assert.equal(state.task.assigneeId, null);
  assert.equal(state.task.dueOn, null);
  assert.deepEqual(state.task.tags, []);
  assert.equal(parseClaim(state.task.description).id, claim.id);
  assert.equal(state.task.title, initialTask.title);
});

test('refuses human in-progress work, completed work, malformed claims, and stale task/workflow versions', async t => {
  const { run, state } = await fixture(t);
  for (const category of ['in_progress', 'completed']) {
    state.task.statusCategory = category;
    await assert.rejects(run('claim_task', { taskId: 'task-1', expectedVersion: 1, agentId: 'chat-a' }), { code: 'task_unavailable' });
  }
  state.task.statusCategory = 'not_started';
  await assert.rejects(run('update_task', { taskId: 'task-1', expectedVersion: 0, title: 'Overwrite' }), { code: 'stale_version' });
  await assert.rejects(run('set_status', { taskId: 'task-1', expectedVersion: 1, statusId: 'doing', expectedWorkflowVersion: 3 }), { code: 'stale_version' });
  state.task.description = '<!-- team-time-mcp-claim:broken -->';
  await assert.rejects(run('claim_task', { taskId: 'task-1', expectedVersion: 1, agentId: 'chat-a' }), { code: 'invalid_claim' });
  assert.equal(state.writes, 0);
});

test('remote stale version is not automatically retried or rebased', async t => {
  const { run, state, api } = await fixture(t, { remoteStale: true });
  await assert.rejects(run('update_task', { taskId: 'task-1', expectedVersion: 1, title: 'Overwrite' }), { code: 'stale_version' });
  assert.equal(state.requests.filter(r => r.method === 'PATCH').length, 1);
  assert.deepEqual(await api.store.pending(), []);
});

test('lost response replays identical UUID/payload across retries and process restart without duplicate creation', async t => {
  const { run, state, api, directory, clientOptions } = await fixture(t, { loseResponses: true });
  let commandId;
  await assert.rejects(run('create_task', { title: 'MCP integration', projectId: 'project-1' }), error => {
    assert.equal(error.code, 'response_uncertain');
    assert.ok(!error.message.includes(key));
    commandId = error.details.commandId;
    return true;
  });
  assert.equal(state.writes, 1);
  const requests = state.requests.filter(r => r.method === 'POST');
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests.map(r => r.commandId)).size, 1);
  assert.equal(new Set(requests.map(r => r.body)).size, 1);
  assert.equal((await api.store.pending())[0].commandId, commandId);
  const receiptPath = join(directory, `${commandId}.json`);
  assert.ok(!(await readFile(receiptPath, 'utf8')).includes(key));
  assert.equal((await stat(receiptPath)).mode & 0o777, 0o600);
  state.loseResponses = false;
  const restarted = new TeamTimeClient(clientOptions);
  const response = await restarted.retry(commandId);
  assert.equal(response.commandId, commandId);
  assert.equal(state.writes, 1);
  assert.deepEqual(await restarted.store.pending(), []);
});

test('respects Retry-After without sleeping for long intervals or allowing early replay', async t => {
  const { run, api, state } = await fixture(t, { rateLimit: true });
  let commandId;
  await assert.rejects(run('create_task', { title: 'Work', projectId: 'project-1' }), error => {
    assert.equal(error.details.retryAfterMs, 60_000);
    commandId = error.details.commandId;
    return true;
  });
  await assert.rejects(api.retry(commandId), { code: 'retry_later' });
  assert.equal(state.requests.filter(r => r.method === 'POST').length, 1);
});

test('query arrays use repeated parameters and retain pagination filters', async t => {
  const { run, state } = await fixture(t);
  await run('list_tasks', { projectId: 'project-1', statusCategory: 'in_progress', tagIds: ['a', 'b'], limit: 10, cursor: 'next' });
  const query = new URLSearchParams(state.requests.at(-1).query);
  assert.deepEqual(query.getAll('tagIds'), ['a', 'b']);
  assert.equal(query.get('projectId'), 'project-1');
  assert.equal(query.get('cursor'), 'next');
});

test('workflow status IDs accept the slash-separated IDs returned by production discovery', async t => {
  const { run, state } = await fixture(t);
  const statusId = '00000000-0000-4000-8000-000000000001/status/progress';
  state.workflow.statuses.push({ id: statusId, category: 'in_progress' });
  await run('set_status', { taskId: 'task-1', expectedVersion: 1, statusId, expectedWorkflowVersion: 4 });
  assert.equal(state.task.statusId, statusId);
  assert.equal(state.task.statusCategory, 'in_progress');
});

test('MCP handshake, tools/list, bootstrap, mutation, and errors work through the SDK protocol', async t => {
  const { api } = await fixture(t);
  const server = createServer(api);
  const client = new Client({ name: 'test-client', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const list = await client.listTools();
  assert.equal(list.tools.length, 16);
  assert.equal(list.tools.find(t => t.name === 'team_time_bootstrap').annotations.readOnlyHint, true);
  const boot = await client.callTool({ name: 'team_time_bootstrap', arguments: {} });
  assert.equal(boot.structuredContent.context.organization.id, 'org-1');
  const claim = await client.callTool({ name: 'team_time_claim_task', arguments: { taskId: 'task-1', expectedVersion: 1, agentId: 'protocol-test' } });
  assert.ok(claim.structuredContent.claim.id);
  const busy = await client.callTool({ name: 'team_time_complete_task', arguments: { taskId: 'task-1', expectedVersion: 2 } });
  assert.equal(busy.isError, true);
  assert.equal(busy.structuredContent.error.code, 'task_claimed');
  const invalid = await client.callTool({ name: 'team_time_create_task', arguments: { title: 'Work', projectId: 'project-1', dueOn: '2026-02-31' } });
  assert.equal(invalid.isError, true);
});

test('published executable speaks clean stdio without exposing the credential', async t => {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/index.mjs', import.meta.url))],
    env: { TEAM_TIME_API_KEY: key, TEAM_TIME_ORGANIZATION_ID: 'org-1' }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'stdio-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 16);
  assert.equal(stderr, '');
});

test('npm-style executable symlink starts the stdio server', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'team-time-mcp-bin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'team-time-mcp');
  await symlink(fileURLToPath(new URL('../src/index.mjs', import.meta.url)), bin);
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin],
    env: { TEAM_TIME_API_KEY: key, TEAM_TIME_ORGANIZATION_ID: 'org-1' }, stderr: 'pipe' });
  const client = new Client({ name: 'bin-symlink-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 16);
});
