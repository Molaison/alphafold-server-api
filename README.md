# alphafold-server-api

Unofficial, reverse-engineered client for **AlphaFold Server** (alphafoldserver.com).
Lets you submit fold jobs, poll status, and download results from the command
line or from Node — instead of clicking through the web UI.

> **Not affiliated with Google DeepMind / Isomorphic Labs / Google.**
> AlphaFold Server output is for **non-commercial use only** and may not be used
> in docking or screening tools. You are responsible for complying with the
> [Terms of Use](https://alphafoldserver.com/terms) and for any quota you spend.
> See [LICENSE](LICENSE).

---

## What works

| Capability | Status |
|---|---|
| Session reuse from cookies | ✅ verified |
| Read quota | ✅ verified |
| List job history | ✅ verified |
| Job / per-model details | ✅ verified |
| Cost estimate | ✅ verified |
| **Submit a fold job** | ✅ verified (real jobs created) |
| **Download results** (`model.cif`, `full_data.json`, …) | ✅ verified |
| **Rename a job** | ✅ verified |
| **Delete (archive) a job** | ✅ verified |
| Browser-assisted login + cookie export | ✅ verified |

`GetMsas` / `GetTemplates` argument shapes are not fully mapped.

---

## Install

```bash
git clone https://github.com/<you>/alphafold-server-api.git
cd alphafold-server-api
npm install          # only needed for the login helper (playwright-core)
```

Node 18+.

---

## 1. Get a session

```bash
node login.js
```

A real Chrome window opens. Complete the Google sign-in yourself (email →
password → 2FA); the script watches for `OSID` + `__Secure-OSID` and writes
`af3_cookies.txt` as soon as you land back on the app. No manual export needed.

Options:

```bash
node login.js --out my-cookies.json     # custom output path
node login.js --profile ./profile       # persistent profile: log in once, reuse
node login.js --timeout 300             # wait limit in seconds (default 180)
node login.js --seed existing.json      # re-import / convert an existing jar
```

Already have a cookie export from a browser extension? Just point `--cookies`
at it — the JSON, Netscape, and `a=b; c=d` formats are all accepted.

Verify it works:

```bash
node af3.js user --cookies af3_cookies.txt
```

---

## 2. Use it

```bash
export COOKIES=./af3_cookies.txt     # or pass --cookies on every call
```

### Inspect

```bash
node af3.js user                       # who am I
node af3.js quota                      # remaining daily jobs
node af3.js jobs                       # job history
node af3.js job  <jobId>               # one job
node af3.js folds <foldId>             # one predicted model
```

### Submit

```bash
node af3.js cost   examples/input.json           # seconds, no quota spent
node af3.js submit examples/input.json --dry-run # print the exact payload
node af3.js submit examples/input.json           # spends 1 job from your quota
```

`examples/input.json` uses the same document format as the site's *Upload JSON*
box:

```json
{
  "name": "my-job",
  "modelSeeds": ["1"],
  "dialect": "alphafoldserver",
  "sequences": [
    { "proteinChain": { "sequence": "MKTAYIAKQRQISFVKSHFSRQ...", "count": 1 } }
  ]
}
```

### Watch + download

```bash
node af3.js watch    <jobId>                  # poll until done
node af3.js download <jobId> ./out            # all models: cif + confidences + request
node af3.js download <jobId> ./out --folds    # also per-model GetFold records
```

### Rename / delete

```bash
node af3.js rename <jobId> "new name"
node af3.js delete <jobId> [moreIds...]
```

`delete` is a **soft delete** (the job leaves the history list). It does **not**
refund quota.

### Escape hatch

```bash
node af3.js raw <rpcid|MethodName> '<json argument array>'
```

## As a library

```js
const { AF3Client, buildSubmitPayload } = require('./af3_client');

const c = new AF3Client({ cookieFile: './af3_cookies.txt' });

// read
const job = await c.getFoldJob('56347a534eb553ce');
const foldIds = job.data[5].map((x) => x[0]);   // one id per model

// download (no extra auth needed)
const cif = await c.fetchAsset('56347a534eb553ce', 0, 'model.cif');
require('fs').writeFileSync('model.cif', cif.body);

// submit — payload IS the RPC argument list, don't wrap it again
const payload = buildSubmitPayload(doc);
await c.rpc('kMnDgb', payload);

// rename / delete
await c.renameJob('56347a534eb553ce', 'new name');
await c.archiveJob('56347a534eb553ce');
```

---

## Notes that will save you time

- **Quota is 30 jobs per day**, reset at UTC midnight. Submitting spends one;
  deleting does not give it back. `code 8` means you are out.
- **`jobId` is not `foldId`.** Per-model assets are addressed by the ids in
  `job[5]`, not by the job id.
- **`code 3` is ambiguous** — it fires for both a malformed payload and an
  exhausted quota. `code 8` is the unambiguous quota signal.
- **Run `npm run verify` after touching the encoder.** It compares the built
  request against a real browser capture byte-for-byte, offline, spending
  nothing.

---

## Layout

```
af3_client.js        transport, RPC map, JSPB encoder, FoldJob builder
af3.js               CLI
login.js             browser-assisted login + cookie export
verify_offline.js    byte-level check of the encoder (no network)
examples/input.json  sample job document
docs/PROTOCOL.md     the full reverse-engineering write-up
```

Protocol details — the `batchexecute` framing, the XSRF handshake, the sparse
array encoding, the create/update/delete field maps, and the login chain — are
documented in **[docs/PROTOCOL.md](docs/PROTOCOL.md)**.

---

## License

MIT for the code in this repository. That grant covers no rights to the
AlphaFold Server service, its models, or its outputs.
