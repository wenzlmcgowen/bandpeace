/* fake-engine-server.js — serves the REAL board-backend/Code.gs over HTTP.
 *
 * Apps Script can't run locally, so this puts the engine (running on the
 * in-memory sheets from gas-harness.js) behind a local URL. That lets the
 * founder-os CLI be tested end to end — real argument parsing, real HTTP,
 * real engine validation — without deploying anything to Google.
 *
 *   node tests/fake-engine-server.js <port> <board-token> <shows-token>
 */
'use strict';

const http = require('http');
const { URL } = require('url');
const { loadEngine } = require('./gas-harness');

const port = Number(process.argv[2] || 8899);
const board = process.argv[3];
const shows = process.argv[4];
const { call } = loadEngine({ board, shows });

http.createServer((req, res) => {
  const send = (obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      /* Apps Script answers /exec to any origin; match that so the real page
         can be pointed here during testing. */
      'Access-Control-Allow-Origin': '*'
    });
    res.end(body);
  };
  if (req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const params = {};
    u.searchParams.forEach((v, k) => { params[k] = v; });
    return send(call.get(params));
  }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    try { send(call.postRaw(raw)); }
    catch (e) { send({ ok: false, error: 'harness: ' + e.message }); }
  });
}).listen(port, () => console.log('fake engine on ' + port));
