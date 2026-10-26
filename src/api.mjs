import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETENTION = 7 * 24 * 60 * 60 * 1000;

export class TeamTimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// Receipts contain commands and task data, never credentials or authorization headers.
export class CommandStore {
  constructor(directory) { this.directory = directory; }
  path(id) {
    if (!UUID.test(id)) throw new TeamTimeError('invalid_command', 'Command ID must be a UUID.');
    return join(this.directory, `${id}.json`);
  }
  async save(command) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.path(command.id);
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(command), { mode: 0o600, flag: 'wx' });
    await rename(temp, target);
  }
  async get(id) {
    let command;
    try { command = JSON.parse(await readFile(this.path(id), 'utf8')); }
    catch (error) {
      if (error instanceof TeamTimeError) throw error;
      throw new TeamTimeError('command_not_found', 'No retained command with that ID.');
    }
    if (Date.now() - command.createdAt >= RETENTION) {
      throw new TeamTimeError('command_expired', 'Replay window expired; inspect the task before issuing a new command.');
    }
    return command;
  }
  async pending() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const pending = [];
    for (const file of await readdir(this.directory)) {
      if (!UUID.test(file.replace(/\.json$/, '')) || !file.endsWith('.json')) continue;
      const command = JSON.parse(await readFile(join(this.directory, file), 'utf8'));
      if (Date.now() - command.createdAt >= RETENTION) {
        await unlink(join(this.directory, file));
      } else if (command.state === 'pending') {
        pending.push({ commandId: command.id, operation: command.operation, method: command.method,
          path: command.path, createdAt: new Date(command.createdAt).toISOString() });
      }
    }
    return pending;
  }
}

export class TeamTimeClient {
  constructor({ apiKey, organizationId, origin = 'https://time.wscm.eu', stateDirectory,
    fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeout = 15_000 }) {
    if (!apiKey?.trim()) throw new TeamTimeError('configuration', 'Set TEAM_TIME_API_KEY in the MCP process environment.');
    if (!organizationId?.trim()) throw new TeamTimeError('configuration', 'Set TEAM_TIME_ORGANIZATION_ID to the expected organization ID.');
    const url = new URL(origin);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new TeamTimeError('configuration', 'TEAM_TIME_ORIGIN must be an HTTPS origin (HTTP is allowed only on loopback).');
    }
    this.apiKey = apiKey.trim();
    this.organizationId = organizationId;
    this.base = `${url.origin}/api/v1`;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.timeout = timeout;
    // Isolate receipts by deployment, organization, and credential without persisting the credential.
    const namespace = createHash('sha256').update(`${this.base}\0${organizationId}\0${this.apiKey}`).digest('hex').slice(0, 24);
    this.store = new CommandStore(stateDirectory ?? join(homedir(), '.local', 'state', 'team-time-mcp', namespace));
  }

  redact(value) {
    return JSON.parse(JSON.stringify(value).split(this.apiKey).join('[REDACTED]'));
  }

  async send(method, path, { query, body, commandId } = {}) {
    if (!/^\/[a-z][a-z0-9/_.-]*$/i.test(path)) throw new TeamTimeError('invalid_path', 'Invalid API resource path.');
    const url = new URL(`${this.base}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) {
        for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
      }
    }
    const headers = { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' };
    if (commandId) headers['Idempotency-Key'] = commandId;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload && Buffer.byteLength(payload) > 65536) throw new TeamTimeError('body_too_large', 'API request exceeds 64 KiB.');

    for (let attempt = 0; attempt < 3; attempt++) {
      let response, result;
      try {
        response = await this.fetch(url, { method, headers, body: payload, redirect: 'error', signal: AbortSignal.timeout(this.timeout) });
        result = response.status === 204 ? {} : this.redact(await response.json());
      } catch {
        if (attempt < 2) { await this.sleep(250 * 2 ** attempt); continue; }
        throw new TeamTimeError('response_uncertain', 'No complete API response. Retry the retained command; do not create a replacement.', { commandId });
      }
      if (response.ok) return result;
      const retryAfter = response.headers.get('retry-after');
      const retryMs = retryAfter == null ? 250 * 2 ** attempt :
        /^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && Number.isFinite(retryMs) && retryMs <= 3000 && attempt < 2) {
        await this.sleep(retryMs); continue;
      }
      throw new TeamTimeError(result.error?.code ?? 'api_error', result.error?.message ?? 'Team Time API request failed.', {
        status: response.status, requestId: result.requestId, commandId,
        ...(retryable ? { retryAfterMs: Number.isFinite(retryMs) ? retryMs : null } : {}),
        ...(result.error?.code === 'stale_version' ? { action: 'Re-read the task and workflow. Reconsider the change before issuing a new command.' } : {})
      });
    }
  }

  async context() {
    const response = await this.send('GET', '/context');
    if (response.data.organization.id !== this.organizationId) {
      throw new TeamTimeError('organization_mismatch', 'The key belongs to a different organization; no further operations were performed.');
    }
    this.currentContext = response.data;
    return response;
  }

  async authorize(operation) {
    if (!this.currentContext) await this.context();
    if (!this.currentContext.operations.includes(operation)) {
      throw new TeamTimeError('operation_not_allowed', `The key does not allow ${operation}.`);
    }
  }

  async read(operation, path, query) {
    await this.authorize(operation);
    return this.send('GET', path, { query });
  }

  async all(operation, path, filters = {}) {
    const data = [];
    const seen = new Set();
    let cursor;
    do {
      const page = await this.read(operation, path, { ...filters, limit: 100, cursor });
      data.push(...page.data);
      cursor = page.page.nextCursor;
      if (cursor && seen.has(cursor)) throw new TeamTimeError('pagination_loop', 'The API returned a repeated cursor.');
      if (cursor) seen.add(cursor);
      if (data.length >= 10_000 && cursor) throw new TeamTimeError('collection_too_large', 'Narrow the filters before continuing.');
    } while (cursor);
    return data;
  }

  async mutate(operation, method, path, body) {
    await this.authorize(operation);
    if (Buffer.byteLength(JSON.stringify(body)) > 65536) throw new TeamTimeError('body_too_large', 'API request exceeds 64 KiB.');
    const command = { id: randomUUID(), operation, method, path, body,
      createdAt: Date.now(), state: 'pending' };
    await this.store.save(command); // Persist before sending, so process restarts can replay it.
    return this.execute(command);
  }

  async execute(command) {
    try {
      const response = await this.send(command.method, command.path, { body: command.body, commandId: command.id });
      await this.store.save({ ...command, state: 'succeeded' });
      return { ...response, commandId: command.id };
    } catch (error) {
      // HTTP 4xx (except 429) are definitive. Never automatically rebase a stale command.
      if (error instanceof TeamTimeError && error.details.status >= 400 && error.details.status < 500 && error.details.status !== 429) {
        await this.store.save({ ...command, state: 'rejected' });
      } else if (error instanceof TeamTimeError && error.details.retryAfterMs != null) {
        await this.store.save({ ...command, notBefore: Date.now() + error.details.retryAfterMs });
      }
      if (error instanceof TeamTimeError) throw error;
      throw new TeamTimeError('receipt_uncertain', 'Receipt storage failed; retry this command with its original ID.', { commandId: command.id });
    }
  }

  async retry(id) {
    const command = await this.store.get(id);
    if (command.notBefore > Date.now()) throw new TeamTimeError('retry_later', 'Observe Retry-After before replaying this command.', {
      commandId: id, retryAfterMs: command.notBefore - Date.now()
    });
    // Refresh access before every explicit replay; the HTTP API remains authoritative.
    await this.context();
    await this.authorize(command.operation);
    if (command.state === 'rejected') throw new TeamTimeError('command_rejected', 'This command was definitively rejected. Re-read and reconsider before a new command.');
    return this.execute(command);
  }
}
