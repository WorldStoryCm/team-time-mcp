import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { TeamTimeError } from './api.mjs';

const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Project knowledge · Team Time</title><link rel="stylesheet" href="/local.css"><link rel="stylesheet" href="/explorer.css"><main><header><p id="project">Local project</p><h1>Knowledge</h1></header><section id="knowledge" class="knowledge-explorer"></section></main><script type="module" src="/screen.mjs"></script></html>`;

export async function startViewer(api) {
  const token = randomBytes(32).toString('base64url');
  let origin;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    );
    function send(status, type, content) {
      res.writeHead(status, { 'Content-Type': type });
      res.end(content);
    }
    const json = (status, value) =>
      send(status, 'application/json', JSON.stringify(value));
    try {
      if ('http://' + req.headers.host !== origin)
        return json(403, { error: 'Unknown host.' });
      const url = new URL(req.url, origin);
      if (req.method === 'GET') {
        if (url.pathname === '/')
          return send(200, 'text/html; charset=utf-8', html);
        const assets = {
          '/explorer.css': './knowledge/explorer.css',
          '/explorer.mjs': './knowledge/explorer.mjs',
          '/screen.mjs': './viewer-screen.mjs',
          '/local.css': './viewer.css'
        };
        if (Object.hasOwn(assets, url.pathname))
          return send(
            200,
            url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
            await readFile(new URL(assets[url.pathname], import.meta.url))
          );
      }
      if (req.method !== 'POST' || url.pathname !== '/query')
        return json(404, { error: 'Unknown resource.' });
      if (
        req.headers.origin !== origin ||
        req.headers.authorization !== 'Bearer ' + token
      )
        return json(403, {
          error: 'Open the private viewer link printed by Team Time.'
        });
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) return json(413, { error: 'Request too large.' });
        chunks.push(chunk);
      }
      const { op, id, args, commandId } = JSON.parse(
        Buffer.concat(chunks).toString()
      );
      const path = '/projects/' + api.project.id + '/knowledge';
      if (op === 'info') return json(200, api.project);
      if (op === 'list')
        return json(200, (await api.read('listKnowledge', path, args)).data);
      if (!/^[a-f0-9-]{36}$/i.test(id))
        return json(400, { error: 'Invalid record ID.' });
      if (op === 'check')
        return json(
          200,
          (
            await api.read(
              'checkKnowledge',
              path + '/proposals/' + id + '/check'
            )
          ).data
        );
      if (op === 'note' || op === 'proposal')
        return json(
          200,
          (
            await api.read(
              op === 'note' ? 'getKnowledgeNote' : 'getKnowledgeProposal',
              path + (op === 'note' ? '/notes/' : '/proposals/') + id
            )
          ).data
        );
      if (op === 'decide' && /^[a-f0-9-]{36}$/i.test(commandId))
        return json(
          200,
          (
            await api.send('POST', path + '/proposals/' + id + '/decision', {
              body: args,
              commandId
            })
          ).data
        );
      return json(400, { error: 'Invalid operation.' });
    } catch (error) {
      json(
        error instanceof TeamTimeError ? (error.details.status ?? 400) : 400,
        {
          error:
            error instanceof TeamTimeError
              ? error.message
              : 'Unable to process the viewer request.'
        }
      );
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = 'http://127.0.0.1:' + server.address().port;
  return {
    url: origin + '/#' + token,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
