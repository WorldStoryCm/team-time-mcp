import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { configuredClient } from '../src/client.mjs';

test('auto selects exactly one backend and a failed cloud operation never creates a local database', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'team-time-choose-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const env = { TEAM_TIME_LOCAL_DIR: dir };
  await assert.rejects(
    configuredClient({ ...env, TEAM_TIME_API_KEY: 'example' }),
    { code: 'configuration' }
  );
  const cloud = await configuredClient({
    ...env,
    TEAM_TIME_API_KEY: 'example',
    TEAM_TIME_ORGANIZATION_ID: 'org'
  });
  cloud.fetch = async () => {
    throw new Error('offline');
  };
  cloud.sleep = async () => {};
  await assert.rejects(cloud.context(), { code: 'response_uncertain' });
  assert.deepEqual(await readdir(dir), []);
  const local = await configuredClient(env);
  assert.equal((await local.context()).data.storage, 'local');
  local.close();
  assert.equal((await stat(join(dir, 'time.sqlite'))).mode & 0o077, 0);
});

test('independent stdio agents share embedded task claims and reviewed revisions across restarts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'team-time-local-e2e-')),
    clients = new Set();
  t.after(async () => {
    for (const cli of clients) await cli.close();
    await rm(dir, { recursive: true, force: true });
  });
  async function connect() {
    const client = new Client({ name: 'local-test', version: '1' });
    clients.add(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL('../src/index.mjs', import.meta.url))],
        env: { TEAM_TIME_LOCAL_DIR: dir },
        stderr: 'pipe'
      })
    );
    return async (name, args = {}) => {
      const result = await client.callTool({
        name: 'team_time_' + name,
        arguments: args
      });
      if (result.isError)
        throw Object.assign(
          new Error(result.structuredContent.error.message),
          result.structuredContent.error
        );
      return result.structuredContent;
    };
  }
  const [a, b] = await Promise.all(Array.from({ length: 4 }, () => connect()));
  const boot = await a('bootstrap'),
    projectId = boot.projects[0].id;
  const task = (
    await a('create_task', {
      projectId,
      title: 'Document routing',
      tags: ['Agents']
    })
  ).data;
  const claims = await Promise.allSettled(
    [a, b].map((run, i) =>
      run('claim_task', {
        taskId: task.id,
        expectedVersion: task.version,
        agentId: 'local-' + i
      })
    )
  );
  assert.equal(claims.filter((c) => c.status === 'fulfilled').length, 1);
  const { data: claimed, claim } = claims.find(
    (c) => c.status === 'fulfilled'
  ).value;
  const active = (
    await a('set_status', {
      taskId: task.id,
      expectedVersion: claimed.version,
      claimId: claim.id,
      statusId: 'doing',
      expectedWorkflowVersion: 0
    })
  ).data;
  const done = (
    await a('complete_task', {
      taskId: task.id,
      expectedVersion: active.version,
      claimId: claim.id,
      result: 'Checked README.'
    })
  ).data;
  await a('release_claim', {
    taskId: task.id,
    expectedVersion: done.version,
    claimId: claim.id
  });
  const draft = {
    projectId,
    title: 'Storage routing',
    content: 'SQLite on disk',
    category: 'fact',
    evidence: 'README at A'
  };
  const p = (await a('knowledge_propose', draft)).data;
  assert.equal(
    (await b('knowledge_search', { projectId })).data.items.length,
    0
  );
  const first = (
    await b('knowledge_review', {
      projectId,
      proposalId: p.id,
      action: 'approve',
      reason: 'Checked A.'
    })
  ).data;
  const updated = (
    await a('knowledge_propose', {
      ...draft,
      content: 'Cloud when configured',
      evidence: 'README at B'
    })
  ).data;
  assert.equal(
    (await b('knowledge_check', { projectId, proposalId: updated.id })).data
      .candidates[0].basis,
    'same_title'
  );
  const decision = {
    projectId,
    proposalId: updated.id,
    action: 'merge',
    reason: 'A and B cover different configurations.',
    target: { noteId: first.noteId, revision: 1 },
    mergedContent: 'Cloud when configured, SQLite otherwise.'
  };
  const race = await Promise.allSettled(
    [a, b].map((run) => run('knowledge_review', decision))
  );
  assert.equal(race.filter((c) => c.status === 'fulfilled').length, 1);
  assert.equal(
    race.find((c) => c.status === 'rejected').reason.code,
    'stale_version'
  );
  for (const cli of clients) await cli.close();
  clients.clear();
  const fresh = await connect();
  assert.deepEqual(
    (
      await fresh('knowledge_note', { projectId, noteId: first.noteId })
    ).data.history.map((n) => n.evidence),
    ['README at B', 'README at A']
  );
  assert.equal(
    (await fresh('list_tasks', { projectId, statusCategory: 'completed' }))
      .data[0].id,
    task.id
  );
});
