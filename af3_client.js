/**
 * af3_client.js - AlphaFold Server (alphafoldserver.com) reverse-engineered API client
 *
 * Everything here is derived from the shipped front-end bundles:
 *   - RPC descriptors  : module _b (main bundle) -> {Fb: rpcid, wc: grpc method}
 *   - RPC transport    : POST /_/AlphaFoldUi/data/batchexecute  (WIZ_global_data.eptZe)
 *   - Payload encoding : JSPB "%.@" wire JSON (see jspb()/af3Payload() below)
 *   - Result assets    : GET /_/v2/folds/<foldId>/<index>/{model.cif,full_data.json,summary_confidences.json}
 *   - Result archive   : GET /_/v2/folds/<foldId>/<index>/<foldId>.zip
 *
 * Usage:
 *   node af3_client.js cookie-check
 *   node af3_client.js user
 *   node af3_client.js quota
 *   node af3_client.js jobs
 *   node af3_client.js job <foldId>
 *   node af3_client.js submit <input.json> [--title T] [--dry-run]
 *   node af3_client.js watch <foldId>
 *   node af3_client.js download <foldId> <outDir>
 *   node af3_client.js raw <rpcid> '<json-array-request>'
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const ORIGIN = 'https://alphafoldserver.com';
const RPC_ROOT = '/_/AlphaFoldUi/data/batchexecute';
const COOKIE_FILE_DEFAULT = path.join(__dirname, '..', 'af3_cookies.txt');

/* ------------------------------------------------------------------ *
 * RPC id map (rpcid -> gRPC method), extracted from module `_b`
 * ------------------------------------------------------------------ */
const RPC = {
  CalculateFoldCost:            { id: 'Gbje0',   path: '/FoldService.CalculateFoldCost' },
  CountCustomMsasCreated:       { id: 'oDm7cc',  path: '/FoldService.CountCustomMsasCreated' },
  CountCustomTemplatesCreated:  { id: 'pwXru',   path: '/FoldService.CountCustomTemplatesCreated' },
  CreateDownload:               { id: 'YeS2Vb',  path: '/FoldService.CreateDownload' },
  CreateFoldJob:                { id: 'kMnDgb',  path: '/FoldService.CreateFoldJob' },
  CreateMsa:                    { id: 'rPXxMb',  path: '/FoldService.CreateMsa' },
  CreateTemplate:               { id: 'KNbI3',   path: '/FoldService.CreateTemplate' },
  GetCcdInfo:                   { id: 'jX4pge',  path: '/FoldService.GetCcdInfo' },
  GetDownload:                  { id: 'bWZJNb',  path: '/FoldService.GetDownload' },
  GetExampleFoldJob:            { id: 'vyuJrc',  path: '/FoldService.GetExampleFoldJob' },
  GetFoldJob:                   { id: 'EXvXWc',  path: '/FoldService.GetFoldJob' },
  GetFoldJobs:                  { id: 'uCiTI',   path: '/FoldService.GetFoldJobs' },
  GetFoldQuota:                 { id: 'tjI49c',  path: '/FoldService.GetFoldQuota' },
  GetFold:                      { id: 'Tkddhb',  path: '/FoldService.GetFold' },
  GetFolds:                     { id: 'yYrXS',   path: '/FoldService.GetFolds' },
  GetMsasWith:                  { id: 'qqzLwf',  path: '/FoldService.GetMsasWith' },
  GetMsas:                      { id: 'oYroVe',  path: '/FoldService.GetMsas' },
  GetTemplates:                 { id: 'HIFwNc',  path: '/FoldService.GetTemplates' },
  ListFoldJobs:                 { id: 'IbBsAc',  path: '/FoldService.ListFoldJobs' },
  UpdateFoldJob:                { id: 'bteK7',   path: '/FoldService.UpdateFoldJob' },
  UpdateFoldJobs:               { id: 'GNrSbe',  path: '/FoldService.UpdateFoldJobs' },
  CreateUser:                   { id: 'O7tEmb',  path: '/UserService.CreateUser' },
  GetUser:                      { id: 'EU26qc',  path: '/UserService.GetUser' },
  UpdateUser:                   { id: 'Lg5BMe',  path: '/UserService.UpdateUser' },
};

/** reverse lookup: rpcid -> human name */
const RPC_BY_ID = Object.fromEntries(Object.entries(RPC).map(([k, v]) => [v.id, k]));

/* ------------------------------------------------------------------ *
 * JSPB wire-JSON encoding ("%.@" dialect)
 *
 * The front-end never sends protobuf binaries: `msg.serialize()` produces
 * a compact JSON array where index N == protobuf field N (0-based on the
 * wire means index 0 == field 1), and proto3-default values are omitted.
 * ------------------------------------------------------------------ */

/** Set field `n` (1-based proto field number) on a sparse JSPB array. */
function setField(arr, n, value) {
  if (value === undefined || value === null || value === '') return arr;
  arr[n - 1] = value;
  return arr;
}

/** Nested message -> array (or undefined when empty). */
function msg(fields) {
  const a = [];
  let touched = false;
  for (const [n, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0 && !isProtoScalarList(v)) continue;
    a[Number(n) - 1] = v;
    touched = true;
  }
  return touched ? a : undefined;
}

function isProtoScalarList(v) {
  return v.length > 0 && v.every((x) => typeof x !== 'object');
}

/**
 * Normalise a JS array into the exact shape the JSPB serializer emits.
 *
 * Rules verified against a real browser capture (`f.req` byte-for-byte):
 *  - nested arrays are compacted recursively
 *  - empty arrays are dropped to `null` (proto3 repeated + zero items)
 *  - trailing nulls/undefined are trimmed (proto3 drops trailing defaults)
 *  - interior holes stay `null` (they keep later fields at their index)
 *
 * Getting this right matters: sending `[]` where the UI sends `null`, or a
 * trailing `null` the UI omits, makes CreateFoldJob fail with
 * INVALID_ARGUMENT even though the semantic content is identical.
 */
function compact(arr) {
  if (!Array.isArray(arr)) return arr;

  const norm = arr.map((v) => {
    if (v === undefined) return null;
    if (Array.isArray(v)) {
      if (v.length === 0) return null;
      const c = compact(v);
      return c.length === 0 ? null : c;
    }
    return v;
  });

  let last = -1;
  norm.forEach((v, i) => { if (v !== null) last = i; });
  return norm.slice(0, last + 1);
}

/**
 * AF3 request envelope. Empirically verified against the live endpoint:
 * the RPC payload IS the bare FoldJob array, i.e.
 *
 *   f.req = [[["<rpcid>", "<json(FoldJob)>", null, "generic"]]]
 *
 * `foldRequest()` therefore only normalises a FoldJob array; the extra
 * `{1: {1: ...}}` nesting the bundle's helper types imply is NOT sent.
 */
function foldRequest(reqInput) {
  return compact(reqInput || []);
}

/* ------------------------------------------------------------------ *
 * Request encoding
 * ------------------------------------------------------------------ */

/**
 * Build the `f.req` value for one RPC call.
 *
 *   [[[ "<rpcid>", "<JSON(args)>", null, "generic" ]]]
 *
 * The tuple sits inside TWO wrapper arrays. Dropping one makes every RPC
 * answer with an `er`/400 transport frame instead of a result.
 *
 * `reqInput` is the RPC argument list and is serialised verbatim — do not add
 * another array level around it. `[{}]` is folded to `[]` because that is what
 * the UI sends for argument-less calls.
 *
 * Exported so `verify_offline.js` can check this exact code path rather than a
 * reimplementation of it.
 */
function buildReq(rpcid, reqInput) {
  const raw = JSON.stringify(reqInput ?? []);
  const payload = compact([
    compact([compact([rpcid, raw === '[{}]' ? '[]' : raw, null, 'generic'])]),
  ]);
  return JSON.stringify(payload);
}

/* ------------------------------------------------------------------ *
 * Cookie jar (Netscape/JSON export or a plain "a=b; c=d" string)
 * ------------------------------------------------------------------ */
function loadCookies(file) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  let pairs = [];
  if (raw.startsWith('[') || raw.startsWith('{')) {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : (parsed.cookies || []);
    for (const c of list) pairs.push([c.name, c.value]);
  } else if (raw.startsWith('# Netscape') || raw.includes('\t')) {
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const p = line.split('\t');
      if (p.length >= 7) pairs.push([p[5], p[6]]);
    }
  } else {
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) pairs.push([part.slice(0, i).trim(), part.slice(i + 1).trim()]);
    }
  }
  return pairs;
}

function cookieHeader(pairs) {
  return pairs.map(([k, v]) => `${k}=${v}`).join('; ');
}

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */
function request(opts, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(opts.url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        method: opts.method || 'GET',
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: opts.headers || {},
        timeout: opts.timeout || 120000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ------------------------------------------------------------------ *
 * Client
 * ------------------------------------------------------------------ */
class AF3Client {
  constructor(opts = {}) {
    this.cookies = loadCookies(opts.cookieFile || COOKIE_FILE_DEFAULT);
    this.cookie = cookieHeader(this.cookies);
    this.origin = opts.origin || ORIGIN;
    this.bl = 'boq_deepmind-alphafoldserver-web_20261018.00_p0'; // WIZ_global_data.cfb2h
    this.sid = '1167924788998423174';                            // WIZ_global_data.FdrFJe
    this._xid = 1;
  }

  _headers(extra = {}) {
    return Object.assign(
      {
        Cookie: this.cookie,
        Origin: this.origin,
        Referer: this.origin + '/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      extra,
    );
  }

  /**
   * Session bootstrap. ONE page load yields all three values the RPC URL and
   * body need, and they are mutually bound — mixing values from different
   * renders is what makes CreateFoldJob fail with INVALID_ARGUMENT:
   *
   *   f.sid  — WIZ_global_data.FdrFJe, regenerated on every render
   *   bl     — WIZ_global_data.cfb2h, the build label
   *   at     — the XSRF token, appears as AFUB--<session>:<millis>
   *
   * `at` is NOT a header: it travels as the `at` form field beside `f.req`.
   */
  async _session(force) {
    if (this._sess && !force) return this._sess;
    const res = await request({
      url: this.origin + '/',
      headers: this._headers({ Accept: 'text/html' }),
      timeout: 60000,
    });
    const html = res.body.toString('utf8');
    const at = html.match(/AFUB--[A-Za-z0-9_\-]+:[0-9]+/);
    const sid = html.match(/"FdrFJe":"(-?\d+)"/);
    const bl = html.match(/"cfb2h":"([^"]+)"/);

    this._sess = {
      at: at ? at[0] : null,
      sid: sid ? sid[1] : this.sid,
      bl: bl ? bl[1] : this.bl,
    };
    if (this._sess.sid !== this.sid) this.sid = this._sess.sid;
    if (this._sess.bl !== this.bl) this.bl = this._sess.bl;
    return this._sess;
  }

  /** Back-compat alias. */
  async _at(force) {
    return (await this._session(force)).at;
  }

  /**
   * Low-level batchexecute call.
   *
   * `reqInput` is used VERBATIM as the RPC argument list — it is serialized
   * directly into the "payload" slot of the f.req tuple:
   *
   *   f.req = [[[ "<rpcid>", "<JSON(reqInput)>", null, "generic" ]]]
   *
   * Do not add another array layer here: the server does not unwrap one, and
   * CreateFoldJob answers INVALID_ARGUMENT if the payload sits one level deep.
   */
  async rpc(rpcid, reqInput, opts = {}) {
    const sess = await this._session(opts.forceAt);
    if (!sess.at) throw new Error('could not obtain XSRF token (cookies expired?)');

    const body =
      'f.req=' + encodeURIComponent(buildReq(rpcid, reqInput)) + '&at=' + encodeURIComponent(sess.at);

    const sid = opts.sid || sess.sid;
    const bl = opts.bl || sess.bl;
    const url =
      `${this.origin}${RPC_ROOT}?rpcids=${rpcid}` +
      `&source-path=%2F&bl=${encodeURIComponent(bl)}&f.sid=${sid}` +
      `&hl=en-US&_reqid=${this._xid++}&rt=c`;

    const res = await request(
      {
        url,
        method: 'POST',
        headers: this._headers({
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'Content-Length': Buffer.byteLength(body),
          'X-Same-Domain': '1',
        }),
      },
      body,
    );

    const parsed = this._parseBatch(res);
    // Stale token: re-mint the session and retry once.
    if (parsed.xsrfStale && !opts._retried) {
      this._sess = null;
      return this.rpc(rpcid, reqInput, { ...opts, _retried: true, forceAt: true });
    }
    return parsed;
  }

  _parseBatch(res) {
    let text = res.body.toString('utf8');
    if (text.startsWith(")]}'")) text = text.slice(text.indexOf('\n') + 1);
    const out = { status: res.status, rpcid: null, error: null, data: null, xsrfStale: false, raw: text };

    // Transport-level RPC auth failure: the batch answers `er` + 400 and the
    // token is simply stale. There is no "xsrf" literal in that frame, so this
    // must key off the `er` event, not a substring search.
    if (/"er"\s*,/.test(text) && res.status === 400) out.xsrfStale = true;
    if (text.includes('"xsrf"')) {
      out.xsrfStale = true;
      const t = text.match(/AFUB--[A-Za-z0-9_\-]+:[0-9]+/);
      if (t) out.xsrfToken = t[0];
    }

    // Framed rows: first line = byte length, then a JSON array.
    const rows = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      if (/^\d+$/.test(t)) continue;
      if (t.startsWith('[') || t.startsWith('{')) {
        try { rows.push(JSON.parse(t)); } catch { /* length/chunk frames */ }
      }
    }

    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      for (const ev of row) {
        if (!Array.isArray(ev)) continue;
        if (ev[0] === 'wrb.fr') {
          out.rpcid = ev[1];
          if (ev[2] == null && ev[5] != null) {
            out.error = { code: Array.isArray(ev[5]) ? ev[5][0] : ev[5] };
          } else if (typeof ev[2] === 'string') {
            try { out.data = JSON.parse(ev[2]); } catch { out.data = ev[2]; }
          } else {
            out.data = ev[2];
          }
        }
      }
    }
    return out;
  }

  /* ---------------- read-only helpers ----------------
   * Argument shapes below are verified against the live backend; each one was
   * found by probing until the server stopped answering INVALID_ARGUMENT(3).
   */

  async getUser() { return this.rpc(RPC.GetUser.id, []); }

  async getQuota() { return this.rpc(RPC.GetFoldQuota.id, []); }

  /** No arguments: the account's job history. */
  async listJobs() { return this.rpc(RPC.ListFoldJobs.id, [{}]); }

  /** `[[foldId]]` — one job. */
  async getFoldJob(foldId) { return this.rpc(RPC.GetFoldJob.id, [compact([foldId])]); }

  /** `[[{1: foldId}]]` — batch fetch several jobs at once. */
  async getFoldJobs(foldIds) {
    const ids = [].concat(foldIds);
    return this.rpc(RPC.GetFoldJobs.id, [ids.map((id) => compact([id]))]);
  }

  /* --- per-model results: fold ids are NOT job ids (job.5 = repeated fold ids) --- */

  /** `[[{1: foldId}]]` where foldId is a per-model id from job field 6. */
  async getFolds(foldId) { return this.rpc(RPC.GetFolds.id, [[compact([foldId])]]); }

  /** GetFold — richest per-model record (includes the Spanner blob key). */
  async getFold(foldId) { return this.rpc(RPC.GetFold.id, [[compact([foldId])]]); }

  async calculateCost(foldJob) {
    return this.rpc(RPC.CalculateFoldCost.id, [foldJob]);
  }

  /* ---------------- write helpers ---------------- */

  /**
   * UpdateFoldJob argument builder.
   *
   * The request is a 2-element array: [ FoldJobWrapper, FieldMask ].
   * The server only applies the fields named in the mask, so the mask string
   * must match EXACTLY (wrong mask => INVALID_ARGUMENT, not a no-op).
   *
   * Wrapper (`_.GW`) field layout, 1-based like the rest of JSPB:
   *   1  : EW { 1: foldId }
   *   7  : CW { 1: displayName }     <- the FoldJob body
   *   12 : bool archived
   */
  updateFoldJobArgs(foldId, patch) {
    const gw = new Array(12).fill(null);
    gw[0] = [foldId]; // field 1: EW{1: foldId}

    const paths = [];
    if (patch && patch.name !== undefined) {
      gw[6] = [patch.name]; // field 7: CW{1: name}
      paths.push('fold_input.display_name');
    }
    if (patch && patch.archived !== undefined) {
      gw[11] = !!patch.archived; // field 12
      paths.push('archived');
    }
    if (!paths.length) throw new Error('updateFoldJob needs {name} or {archived}');

    return [gw, [paths]];
  }

  /**
   * Rename a job. Mask path is `fold_input.display_name` (verified).
   */
  async renameJob(foldId, name) {
    return this.rpc(RPC.UpdateFoldJob.id, this.updateFoldJobArgs(foldId, { name }));
  }

  /**
   * Archive (= "delete" in the UI) a job. Mask path is `archived` (verified).
   * Verified behaviour: the job disappears from ListFoldJobs. Quota is NOT
   * refunded.
   */
  async archiveJob(foldId) {
    return this.rpc(RPC.UpdateFoldJob.id, this.updateFoldJobArgs(foldId, { archived: true }));
  }

  /** Archive several jobs, one request each, with a small delay. */
  async archiveJobs(foldIds, { delayMs = 700, onEach } = {}) {
    const out = [];
    for (const id of [].concat(foldIds)) {
      const r = await this.archiveJob(id);
      out.push({ id, ok: !r.error, error: r.error || null });
      if (onEach) onEach(out[out.length - 1]);
      if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
    }
    return out;
  }

  /**
   * Build the CreateFoldJob payload.
   *
   * VERIFIED against a real browser submission (DevTools capture). The payload
   * is a 3-element ARRAY, not the `{1:FoldJob,2:FieldMask,...}` message the
   * bundle's helper types imply:
   *
   *   [ FoldJob, dialect, [seed] ]
   *
   * e.g.
   *   [["2026-10-20_19:24",[[[null,"SEQUENCE",null,null,null,null,1,1]]]],1,[1144051370]]
   *
   * Notes that matter:
   *  - `dialect` is 1 for the alphafoldserver/alphafold3 document dialect.
   *  - the seed is a decimal int32 inside its own array, or omitted entirely.
   *  - the job name is what shows up in History; the site uses
   *    "YYYY-MM-DD_HH:MM" when the user does not type one.
   *  - FoldJob's trailing `true` in the sequence (useStructureTemplate) is
   *    omitted in what the UI *sends* but present in what the server returns.
   */
  createFoldJobRequest(foldJob, opts = {}) {
    const dialect = opts.dialect == null ? 1 : opts.dialect;
    const seeds = opts.seeds || opts.seed != null ? [opts.seeds || opts.seed].flat() : null;
    const out = [foldJob, dialect];
    if (seeds && seeds.length) out.push(seeds.map((s) => Number(s)));
    return compact(out);
  }

  /**
   * Submit one fold job.
   *
   * `payload` is already the full RPC argument list (the 3-element array from
   * buildSubmitPayload), so it is passed through unwrapped — wrapping it once
   * more is exactly the mistake that makes CreateFoldJob fail.
   */
  async createFoldJob(payload, opts = {}) {
    return this.rpc(RPC.CreateFoldJob.id, payload, opts);
  }

  /**
   * Package a completed job for download. `[[[[foldId, foldIndex]]]]`
   * returns a download id in `data[0][0]`.
   */
  async createDownload(foldId, index) {
    return this.rpc(RPC.CreateDownload.id, [compact([compact([compact([foldId, index == null ? null : index])])])]);
  }

  /** Resolve a download id from CreateDownload back to its fold ids. */
  async getDownload(downloadId) { return this.rpc(RPC.GetDownload.id, [compact([downloadId])]); }

  async updateFoldJob(foldId, patch) {
    return this.rpc(RPC.UpdateFoldJob.id, [compact([compact([foldId, patch])])]);
  }

  /* ---------------- result assets ---------------- */

  assetUrl(foldId, index, file) {
    return `${this.origin}/_/v2/folds/${foldId}/${index}/${file}`;
  }

  zipUrl(foldId, index) {
    return `${this.origin}/_/v2/folds/${foldId}/${index}/${foldId}.zip`;
  }

  async fetchAsset(foldId, index, file) {
    return request({
      url: this.assetUrl(foldId, index, file),
      headers: this._headers({ Accept: '*/*' }),
      timeout: 300000,
    });
  }

  /* ---------------- MSA / template upload (resumable) ---------------- */

  /**
   * Upload a custom MSA / template. The front-end builds
   *   metadata = WireJson(MsaMetadata{1: proteinSequence, 2: displayName, 8: paired})
   * then performs a Google resumable upload:
   *   POST /_/upload/msa  X-Goog-Upload-Protocol: resumable
   *                       X-Goog-Upload-Command : start
   *   -> X-Goog-Upload-URL
   *   POST <upload-url>   X-Goog-Upload-Command : upload, finalize
   *                       X-Goog-Upload-Offset  : 0
   */
  async upload(kind, fileBuf, metadataObj) {
    const url = `${this.origin}/_/upload/${kind}`;
    const metaJson = JSON.stringify(compact(metadataObj));
    const start = await request(
      {
        url,
        method: 'POST',
        headers: this._headers({
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': String(fileBuf.length),
          'X-Goog-Upload-Header-Content-Type': 'application/octet-stream',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'Content-Length': Buffer.byteLength(metaJson),
        }),
      },
      metaJson,
    );
    const upUrl = start.headers['x-goog-upload-url'];
    if (!upUrl) return { ok: false, stage: 'start', status: start.status, body: start.body.toString() };

    const up = await request(
      {
        url: upUrl,
        method: 'POST',
        headers: {
          ...this._headers(),
          'X-Goog-Upload-Command': 'upload, finalize',
          'X-Goog-Upload-Offset': '0',
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(fileBuf.length),
        },
      },
      fileBuf,
    );
    return { ok: up.status === 200, status: up.status, body: up.body.toString('utf8'), uploadUrl: upUrl };
  }
}

/**
 * FoldJob message construction, mirroring the web UI's builder j7().
 *
 * Ground truth for the accepted document shape is the server's own
 * `/<foldId>/<i>/job_request.json`, which round-trips:
 *
 *   [{
 *     "name": "...",
 *     "modelSeeds": ["1858770163"],
 *     "sequences": [{ "proteinChain": { "sequence": "...", "count": 1,
 *                                       "useStructureTemplate": true } }],
 *     "dialect": "alphafoldserver",
 *     "version": 3
 *   }]
 *
 * Wire layout (0-based JSPB array indices):
 *   FoldJob   { 1: name, 2: repeated Sequence, 3: repeated seed, 4: dialect }
 *   Sequence  { 1: ProteinChain, 3: Ligand, 4: Ion, 5: DnaChain, 6: RnaChain }
 *   ProteinChain { 1: id, 2: sequence, 6: repeated ptm, 7: count,
 *                  8: useStructureTemplate, 9: Timestamp maxTemplateDate,
 *                  10: repeated msaId, 11: repeated templateId }
 */
const DIALECT = { alphafoldserver: 1, alphafold3: 1, MODEL_ENTITY: 1 };

function ptmList(modifications) {
  const out = [];
  for (const m of modifications || []) {
    if (m.ptm === undefined) continue;
    out.push(compact([m.ptm, m.residueIndex]));
  }
  return out;
}

function isoToTimestamp(dateStr) {
  const ms = new Date(dateStr).getTime();
  return compact([Math.floor(ms / 1000), (ms % 1000) * 1000000]);
}

function proteinChain(pc) {
  // The UI always emits useStructureTemplate as 1 for a protein chain (it is
  // the server-side default but the client still sends it explicitly), so we
  // mirror that to keep the wire bytes identical.
  const chain = compact([
    pc.id || null,                                       // 1 id
    pc.sequence,                                         // 2 sequence
    null,                                                // 3
    null,                                                // 4
    null,                                                // 5
    ptmList(pc.modifications),                           // 6 ptm
    pc.count == null ? 1 : pc.count,                     // 7 count
    pc.useStructureTemplate === false ? 0 : 1,           // 8 useStructureTemplate
    pc.maxTemplateDate ? isoToTimestamp(pc.maxTemplateDate) : null, // 9
    pc.msaIds && pc.msaIds.length ? pc.msaIds.slice() : null,       // 10
    pc.templateIds && pc.templateIds.length ? pc.templateIds.slice() : null, // 11
  ]);
  return compact([chain]); // Sequence { 1: proteinChain }
}

function dnaChain(d) {
  const c = compact([d.id || null, d.sequence, d.count == null ? 1 : d.count, ptmList(d.modifications)]);
  return compact([null, null, null, null, c]); // Sequence { 5: dna }
}

function rnaChain(r) {
  const c = compact([r.id || null, r.sequence, r.count == null ? 1 : r.count, ptmList(r.modifications)]);
  return compact([null, null, null, null, null, c]); // Sequence { 6: rna }
}

function ligandSeq(l) {
  // Ligand { 1: ccd enum, 2: copies, 3: CcdCodes { 1: repeated code } }
  // The UI maps known CCDs to an enum, but the code list is the general form,
  // so always send it — that also covers codes with no enum entry.
  const codes = /^CCD_/.test(l.ligand || '') ? String(l.ligand).slice(4) : l.ligand;
  const t4 = compact([
    null,
    l.count == null ? 1 : l.count,
    codes ? compact([compact([codes])]) : null,
  ]);
  return compact([null, null, t4]); // Sequence { 3: ligand }
}

function ionSeq(i) {
  const w4 = compact([i.ion, i.count == null ? 1 : i.count]);
  return compact([null, null, null, w4]); // Sequence { 4: ion }
}

/**
 * Translate a job document into the FoldJob wire array.
 *
 * Accepts the same shape the site's "Upload JSON" box takes:
 *   { name, modelSeeds, dialect, sequences:[{proteinChain|dnaSequence|…}] }
 *
 * Produces `[name, [sequences]]`. dialect and seeds are NOT part of the
 * FoldJob message — the UI sends them as siblings in the RPC payload, which
 * createFoldJobRequest() assembles. See that function.
 */
function buildFoldJob(doc) {
  if (!doc || !Array.isArray(doc.sequences) || doc.sequences.length === 0) {
    throw new Error('input must contain a non-empty "sequences" array');
  }
  const seqs = [];
  for (const s of doc.sequences) {
    const kinds = Object.keys(s);
    if (kinds.length !== 1) throw new Error(`each sequence needs exactly one molecule type, got: ${kinds.join(', ')}`);
    const kind = kinds[0];
    const v = s[kind];
    if (kind === 'proteinChain') seqs.push(proteinChain(v));
    else if (kind === 'dnaSequence') seqs.push(dnaChain(v));
    else if (kind === 'rnaSequence') seqs.push(rnaChain(v));
    else if (kind === 'ligand') seqs.push(ligandSeq(v));
    else if (kind === 'ion') seqs.push(ionSeq(v));
    else throw new Error(`unsupported molecule type: ${kind}`);
  }
  const name = doc.name || new Date().toISOString().slice(0, 16).replace('T', '_');
  return compact([name, seqs]);
}

/** Full CreateFoldJob payload for a document: [FoldJob, dialect, [seeds]]. */
function buildSubmitPayload(doc) {
  const foldJob = buildFoldJob(doc);
  const seeds = (doc.modelSeeds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n));
  const out = [foldJob, 1];
  if (seeds.length) out.push(seeds);
  return compact(out);
}

module.exports = {
  AF3Client, RPC, RPC_BY_ID, buildReq, foldRequest, buildFoldJob, buildSubmitPayload,
  msg, compact, setField, loadCookies, cookieHeader,
};
