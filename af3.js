#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { AF3Client, RPC, RPC_BY_ID, foldRequest, buildFoldJob, buildSubmitPayload, msg, compact } = require('./af3_client');

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
const flags = {};
const pos = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) {
    const k = rest[i].slice(2);
    const v = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
    flags[k] = v;
  } else pos.push(rest[i]);
}

const client = new AF3Client({ cookieFile: flags.cookies });

function out(label, obj) {
  console.log(`\n### ${label}`);
  console.log(JSON.stringify(obj, null, 2));
}

function die(m) {
  console.error('ERROR:', m);
  process.exit(1);
}

/* FoldJob.status -> label, decoded from the bundle's rZ() */
const STATUS = { 1: 'PENDING', 3: 'SUCCEEDED', 4: 'FAILED', 5: 'DRAFT', 6: 'EXAMPLE' };

/* The /_/v2/folds/<jobId>/<index>/<name> whitelist, taken verbatim from the
 * server's own 400 body for an invalid filename. */
const ASSETS = [
  'model.cif',
  'summary_confidences.json',
  'full_data.json',
  'job_request.json',
  'confidence.json',
  'predicted_aligned_error.json',
];

async function main() {
  if (!cmd || cmd === 'help') {
    console.log(`af3 - AlphaFold Server API client

  Read
    node af3.js user                     who am I (verify cookies)
    node af3.js quota                    remaining daily jobs
    node af3.js jobs                     job history
    node af3.js job   <jobId>            one job
    node af3.js folds <foldId>           one predicted model

  Submit
    node af3.js cost   <input.json>      cost estimate (spends no quota)
    node af3.js submit <input.json>      create a job (spends 1 quota)
                          --dry-run      print the payload, send nothing
                          --title NAME   override the job name

  Results
    node af3.js watch    <jobId>         poll until finished
    node af3.js download <jobId> <out>   all models: cif + confidences + request
                          --folds        also per-model GetFold records

  Manage
    node af3.js rename <jobId> <name>    rename (mask: fold_input.display_name)
    node af3.js delete <jobId>...        archive (soft delete; no quota refund)

  Other
    node af3.js raw <rpcid|Name> <json>  raw argument array
    node af3.js --cookies <file> ...     cookie jar (json / netscape / a=b;c=d)
`);
    return;
  }

  if (cmd === 'user') return out('GetUser', await client.getUser());

  if (cmd === 'quota') return out('GetFoldQuota', await client.getQuota());

  if (cmd === 'jobs') return out('ListFoldJobs', await client.listJobs());

  if (cmd === 'job') {
    if (!pos[0]) die('need jobId');
    return out(`GetFoldJob ${pos[0]}`, await client.getFoldJob(pos[0]));
  }

  if (cmd === 'folds') {
    if (!pos[0]) die('need foldId (per-model id, from job field 6)');
    return out(`GetFolds ${pos[0]}`, await client.getFolds(pos[0]));
  }

  if (cmd === 'cost') {
    if (!pos[0]) die('need input.json');
    const doc = JSON.parse(fs.readFileSync(pos[0], 'utf8'));
    return out('CalculateFoldCost', await client.calculateCost(buildFoldJob(doc)));
  }

  if (cmd === 'submit') {
    if (!pos[0]) die('need input.json');
    const doc = JSON.parse(fs.readFileSync(pos[0], 'utf8'));
    if (flags.title) doc.name = flags.title;
    const payload = buildSubmitPayload(doc);
    if (flags['dry-run']) return out('CreateFoldJob payload (dry run)', payload);
    if (flags.cost) return out('CalculateFoldCost', await client.calculateCost(payload[0]));
    // `payload` IS the RPC argument list — do not wrap it again.
    const r = await client.rpc(RPC.CreateFoldJob.id, payload);
    if (r.error && r.error.code === 3) {
      console.error('\nNote: INVALID_ARGUMENT(3) on submit usually means the daily job quota is exhausted.');
      console.error('Check with: node af3.js quota');
    }
    return out('CreateFoldJob', r);
  }

  if (cmd === 'watch') {
    if (!pos[0]) die('need jobId');
    const id = pos[0];
    for (;;) {
      const r = await client.getFoldJob(id);
      const j = r.data;
      if (j) {
        const status = j[1];
        console.log(new Date().toISOString(), 'status=', status, STATUS[status] || '');
        if (status === 3 || status === 6 || status === 4) {
          console.log(JSON.stringify(j, null, 2));
          if (status === 4) process.exit(2);
          return;
        }
      } else {
        console.log(new Date().toISOString(), 'no data', JSON.stringify(r.error));
      }
      await new Promise((r2) => setTimeout(r2, 15000));
    }
  }

  if (cmd === 'download') {
    const id = pos[0];
    if (!id) die('need jobId');
    const outDir = pos[1] || path.join(__dirname, 'out', id);
    fs.mkdirSync(outDir, { recursive: true });

    // Job -> per-model fold ids. FoldJob.6 (index 5) is the repeated fold-id
    // list; those ids -- not the job id -- address the per-model assets.
    const job = await client.getFoldJob(id);
    const j = job.data;
    if (!j) die(`could not read job ${id}: ${JSON.stringify(job.error)}`);
    const foldIds = (j[5] || []).map((x) => (Array.isArray(x) ? x[0] : x));
    if (!foldIds.length) die('job has no fold ids yet (still running or failed)');
    const status = j[1];
    console.log(`job ${id} status=${status} (${STATUS[status] || '?'}) models=${foldIds.length}`);

    let saved = 0;
    for (let i = 0; i < foldIds.length; i++) {
      const prefix = `model_${String(i).padStart(2, '0')}`;
      for (const f of ASSETS) {
        const r = await client.fetchAsset(id, i, f);
        if (r.status === 200 && r.body.length) {
          fs.writeFileSync(path.join(outDir, `${prefix}_${f}`), r.body);
          saved++;
        } else {
          console.log(`  skip ${i}/${f} -> HTTP ${r.status}`);
        }
      }
      if (flags.folds) {
        const fo = await client.getFold(foldIds[i]);
        if (!fo.error) {
          fs.writeFileSync(path.join(outDir, `${prefix}_fold.json`), JSON.stringify(fo.data, null, 2));
          saved++;
        }
      }
    }
    console.log(`saved ${saved} files -> ${outDir}`);
    return;
  }

  if (cmd === 'rename') {
    const id = pos[0];
    const name = pos[1];
    if (!id || !name) die('usage: rename <jobId> <newName>');
    const r = await client.renameJob(id, name);
    if (r.error) die(`rename failed: ${JSON.stringify(r.error)}`);
    const check = await client.getFoldJob(id);
    const actual = check.data && check.data[6] ? check.data[6][0] : undefined;
    return out('rename', { jobId: id, requested: name, confirmedName: actual, ok: actual === name });
  }

  if (cmd === 'delete') {
    const ids = pos.filter(Boolean);
    if (!ids.length) die('usage: delete <jobId> [moreIds...]');
    console.log(`archiving ${ids.length} job(s) — soft delete, quota is not refunded`);
    const results = await client.archiveJobs(ids, {
      onEach: (r) => console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.id}${r.error ? ' ' + JSON.stringify(r.error) : ''}`),
    });
    const ok = results.filter((r) => r.ok).length;
    console.log(`\n${ok}/${ids.length} archived`);
    if (ok !== ids.length) process.exitCode = 2;
    return;
  }

  if (cmd === 'raw') {
    const which = pos[0];
    const body = JSON.parse(pos[1] || '[]');
    const id = RPC[which] ? RPC[which].id : which;
    return out(`raw ${id}`, await client.rpc(id, body));
  }

  die(`unknown command: ${cmd}`);
}

/* minimal GET helper reused by download */
async function request(url, c) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https
      .get({ hostname: u.hostname, path: u.pathname + u.search, headers: { Cookie: c.cookie, Referer: c.origin + '/' } }, (res) => {
        const ch = [];
        res.on('data', (d) => ch.push(d));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch) }));
      })
      .on('error', reject);
  });
}

main().catch((e) => {
  console.error('FATAL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
