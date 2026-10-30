import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoordinationBridge, hookOutput, hooksConfig, callBridge } from '../src/coordination.mjs';
import { coordinationTools } from '../src/coordination-tools.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'team-time-coordination-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.now(), incoming = [], stall;
  const calls = [], api = { store: { directory }, redact: value => value,
    mutate: async (operation, method, path, body) => { calls.push({ operation, body }); if (stall) await stall; return { data: body }; },
    read: async () => ({ data: { messages: incoming } }),
    retry: async () => ({ data: {} }),
  };
  const bridge = new CoordinationBridge(api, { clock: () => now });
  await bridge.load();
  return { bridge, api, calls, advance: ms => { now += ms; }, messages: value => { incoming = value; }, stall: value => { stall = value; } };
}
test('one handler identifies each chat, filters private prompt data and never answers automatically', async () => {
  let input;
  const output = await hookOutput({ session_id: 'chat-b', hook_event_name: 'PreToolUse', turn_id: 'turn-b', prompt: 'PRIVATE', tool_input: { password: 'PRIVATE' } }, async value => { input = value; return { runId: 'run-b', installationId: 'laptop-b', messages: [{ taskId: 'task-b', body: 'Which files?' }] }; });
  assert.deepEqual(Object.keys(input.event).sort(), ['hook_event_name', 'session_id', 'turn_id']);
  assert.match(output.hookSpecificOutput.additionalContext, /Which files/);
  assert.match(output.hookSpecificOutput.additionalContext, /untrusted coordination data/);
  assert.ok(!JSON.stringify(input).includes('PRIVATE'));
  assert.deepEqual(await hookOutput({ session_id: 'chat-b', hook_event_name: 'Stop' }, async () => ({ runId: 'b', messages: [] })), {});
  assert.equal(Object.keys(hooksConfig('shared-handler').hooks).length, 8);
  const setup = await coordinationTools({ store: { directory: '/private/test-state' } }).find(t => t.name === 'team_time_agent_hooks_config').run({});
  assert.equal(Object.keys(setup.config.hooks).length, 8);
  assert.match(setup.config.hooks.SessionStart[0].hooks[0].command, /--socket/);
  assert.ok(!JSON.stringify(setup).includes('TEAM_TIME_API_KEY'));
});
test('two sessions keep independent runs; old Stop cannot stop a new turn, heartbeat cannot invent activity', async t => {
  const f = await fixture(t), event = (session_id, hook_event_name, turn_id) => f.bridge.handle({ action: 'event', event: { session_id, hook_event_name, turn_id } });
  const a = await event('chat-a', 'UserPromptSubmit', 'turn-a'), b = await event('chat-b', 'UserPromptSubmit', 'turn-b');
  assert.notEqual(a.runId, b.runId);
  await f.bridge.flush();
  await event('chat-a', 'UserPromptSubmit', 'turn-a2');
  await event('chat-a', 'Stop', 'turn-a');
  assert.equal(f.bridge.state.sessions['chat-a'].state, 'active');
  await event('chat-b', 'PermissionRequest', 'turn-b');
  assert.equal(f.bridge.state.sessions['chat-b'].state, 'attention');
  const sequence = f.bridge.state.sessions['chat-a'].sequence;
  f.advance(21_000); await f.bridge.flush();
  assert.equal(f.bridge.state.sessions['chat-a'].sequence, sequence);
  await event('chat-b', 'SessionEnd', 'turn-b');
  const endedSequence = f.bridge.state.sessions['chat-b'].sequence;
  for (const terminal of ['Stop', 'Interrupt', 'SessionEnd']) {
    assert.equal((await event('chat-b', terminal, 'turn-b')).runId, b.runId);
    assert.equal(f.bridge.state.sessions['chat-b'].state, 'ended');
    assert.equal(f.bridge.state.sessions['chat-b'].sequence, endedSequence);
  }
  const resumed = await event('chat-b', 'SessionStart');
  assert.notEqual(resumed.runId, b.runId);
});
test('messages survive restart and acknowledge only after the next delivered-context boundary', async t => {
  const f = await fixture(t), event = { session_id: 'chat-b', hook_event_name: 'PreToolUse', turn_id: 'b' };
  const own = await f.bridge.handle({ action: 'event', event });
  const question = { id: randomUUID(), recipientRunId: own.runId, taskId: 'task-b', body: 'Which files?' };
  f.messages([question]); await f.bridge.flush();
  const delivered = await f.bridge.handle({ action: 'event', event });
  assert.equal(delivered.messages[0].id, question.id);
  assert.ok(!f.calls.some(c => c.operation === 'acknowledgeAgentMessages'));
  await f.bridge.handle({ action: 'event', event });
  await f.bridge.flush();
  assert.ok(f.calls.some(c => c.operation === 'acknowledgeAgentMessages' && c.body.messageIds.includes(question.id)));
  const restarted = new CoordinationBridge(f.api); await restarted.load();
  assert.equal(restarted.state.installationId, own.installationId);
  assert.equal(restarted.state.sessions['chat-b'].runId, own.runId);
  assert.equal((await restarted.handle({ action: 'event', event })).messages.length, 0, 'persisted context is not injected until fresh authorization succeeds');
  assert.equal((await stat(restarted.paths.state)).mode & 0o777, 0o600);
});
test('a delayed network request does not block a local hook event', async t => {
  const f = await fixture(t);
  await f.bridge.handle({ action: 'event', event: { session_id: 'chat-b', hook_event_name: 'SessionStart' } });
  let release; f.stall(new Promise(resolve => { release = resolve; }));
  const network = f.bridge.flush();
  const local = await Promise.race([f.bridge.handle({ action: 'event', event: { session_id: 'chat-b', hook_event_name: 'PreToolUse' } }), new Promise(resolve => setTimeout(() => resolve('blocked'), 100))]);
  assert.notEqual(local, 'blocked'); release(); await network;
});
test('private local IPC serves the same installation to multiple hook clients', async t => {
  const f = await fixture(t); await f.bridge.start();
  t.after(() => f.bridge.close());
  const a = await callBridge(f.bridge.paths.socket, { action: 'status' });
  const b = await callBridge(f.bridge.paths.socket, { action: 'status' });
  assert.equal(a.installationId, b.installationId);
  assert.equal((await stat(f.bridge.paths.socket)).mode & 0o777, 0o600);
  await chmod(f.bridge.paths.socket, 0o666);
  await assert.rejects(callBridge(f.bridge.paths.socket, { action: 'status' }), { code: 'bridge_directory' });
  await chmod(f.bridge.paths.socket, 0o600);
  assert.ok(!JSON.stringify(JSON.parse(await readFile(f.bridge.paths.state, 'utf8'))).includes('apiKey'));
});
