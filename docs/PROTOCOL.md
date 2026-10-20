# Protocol notes

Everything here was derived from the shipped front-end bundles of
`alphafoldserver.com` and confirmed against a real, logged-in browser session
using DevTools captures. Byte-level claims are verified by `verify_offline.js`.

---

## 1. Transport: batchexecute

Every business call goes through one Google-internal RPC channel:

```
POST https://alphafoldserver.com/_/AlphaFoldUi/data/batchexecute
     ?rpcids=<ID>&source-path=%2F&bl=<buildLabel>&f.sid=<sid>&hl=en-US&_reqid=<n>&rt=c
Content-Type: application/x-www-form-urlencoded;charset=UTF-8

f.req=<urlencode(JSON)>&at=<urlencode(XSRF)>
```

### f.req shape — two wrapper arrays

```js
[[[ "<rpcid>", "<JSON of the argument list>", null, "generic" ]]]
//  ^^ two wrappers. Dropping one makes every RPC answer er/400.
```

### Response framing

```
)]}'
<byteCount>
[["wrb.fr","<rpcid>","<payload JSON>",null,null,null,"generic"],["di",N],["af.httprm",...]]
<byteCount>
[["e",4,null,null,N]]
```

- `wrb.fr` with a non-null 3rd element → success; `JSON.parse` that string.
- `wrb.fr` with a null 3rd element and `[code]` at index 5 → business error.
- A row starting with `er` and HTTP 400 → stale XSRF token, not a business error.

### The three session values must come from the SAME page load

`at`, `f.sid` and `bl` are all minted per render. Mixing values from two
different `GET /` responses yields `er`/400.

```
GET /  (with cookies)
  ├─ f.sid  ← WIZ_global_data.FdrFJe   (regenerated every render)
  ├─ bl     ← WIZ_global_data.cfb2h    (build label)
  └─ at     ← literal AFUB--<session>:<millis>
```

`at` is **not a header**. It travels as a form field beside `f.req`. Sending it
as `at:` / `X-Same-Domain:` always fails.

---

## 2. Data encoding: JSPB sparse arrays

The client never sends protobuf binaries. `msg.serialize()` produces a sparse
JSON array:

- **array index `i` maps to proto field `i + 1`** (0-based vs 1-based)
- proto3 default values are omitted, so `null` holes keep later fields aligned
- a repeated field is just a JSON array

Two rules are load-bearing (both enforced by `compact()`):

| wrong | right | why |
|---|---|---|
| `[...,null,[],1,1]` | `[...,null,null,1,1]` | an empty repeated field serialises to `null`, not `[]` |
| `[...,1,1,null,null]` | `[...,1,1]` | trailing defaults are trimmed |

Either mistake yields `INVALID_ARGUMENT` even though the semantics are identical.

---

## 3. RPC catalogue

| rpcid | gRPC method | argument shape (verified) |
|---|---|---|
| `EU26qc` | `/UserService.GetUser` | `[]` |
| `tjI49c` | `/FoldService.GetFoldQuota` | `[]` |
| `IbBsAc` | `/FoldService.ListFoldJobs` | `[]` |
| `EXvXWc` | `/FoldService.GetFoldJob` | `[[jobId]]` |
| `uCiTI` | `/FoldService.GetFoldJobs` | `[[[jobIdA],[jobIdB]]]` |
| `Gbje0` | `/FoldService.CalculateFoldCost` | `[submitPayload]` |
| `kMnDgb` | `/FoldService.CreateFoldJob` | `submitPayload` |
| `Tkddhb` | `/FoldService.GetFold` | `[[foldId]]` |
| `yYrXS` | `/FoldService.GetFolds` | `[[{1:foldId}]]` |
| `YeS2Vb` | `/FoldService.CreateDownload` | `[[[[foldId,index]]]]` |
| `bWZJNb` | `/FoldService.GetDownload` | `[[downloadId]]` |
| `bteK7` | `/FoldService.UpdateFoldJob` | `[wrapper,[paths]]` |
| `rPXxMb` | `/FoldService.CreateMsa` | (upload path) |
| `KNbI3` | `/FoldService.CreateTemplate` | `[{}]` |
| `oYroVe` | `/FoldService.GetMsas` | not fully mapped |
| `jX4pge` | `/FoldService.GetCcdInfo` | `[{}]` |

---

## 4. Submitting a job

### Payload is a 3-element array

```js
[ FoldJob, dialect, [seed] ]

// verbatim browser capture:
[["2026-10-20_19:24",[[[null,"MERPYA...",null,null,null,null,1,1]]]],1,[1144051370]]
```

- `dialect` is `1`
- the seed is an int32 inside its own array (omit the whole array for none)
- `FoldJob` = `[name, [repeated Sequence]]`

### Field map (from the UI's `j7()` builder)

```
FoldJob      { 1: name, 2: repeated Sequence, 3: repeated seed, 4: dialect }
Sequence     { 1: proteinChain, 3: ligand, 4: ion, 5: dnaSequence, 6: rnaSequence }
ProteinChain { 1: id, 2: sequence, 6: repeated ptm, 7: count,
               8: useStructureTemplate, 9: Timestamp maxTemplateDate,
               10: repeated msaId, 11: repeated templateId }
DnaChain/RnaChain { 1: id, 2: sequence, 3: count, 4: repeated ptm }
Ligand       { 1: ccd enum, 2: copies, 3: CcdCodes{ 1: repeated code } }
Ion          { 1: ion enum, 2: copies }
```

### Ground-truth schema

The server echoes every job's input back as JSON — use this to sanity-check a
builder instead of guessing:

```
GET /_/v2/folds/<jobId>/<index>/job_request.json
```

```json
[{
  "name": "album_trunc",
  "modelSeeds": ["1858770163"],
  "sequences": [{ "proteinChain": {
      "sequence": "EFKP...AALGL", "count": 1, "useStructureTemplate": true } }],
  "dialect": "alphafoldserver",
  "version": 3
}]
```

Note `useStructureTemplate` lives on the **inner** chain, not on the envelope.

### Status codes

| code | gRPC | meaning |
|---|---|---|
| `3` | INVALID_ARGUMENT | bad shape **or** quota exhausted |
| `5` | NOT_FOUND | wrong id (jobId vs foldId) |
| `6` | ALREADY_EXISTS / permission | account not eligible |
| `7` | PERMISSION_DENIED | no rights |
| `8` | RESOURCE_EXHAUSTED | daily quota spent |

`3 → 8` is the signature of "shape finally correct, only quota left".

`FoldJob.status`: `1` pending, `3` succeeded, `4` failed, `5` draft, `6` example.

---

## 5. Downloading results

### jobId ≠ foldId

`GetFoldJob` returns:

```
[0] jobId
[1] status
[5] repeated foldId   <-- one per predicted model
```

Passing a jobId to `GetFold` returns `NOT_FOUND(5)`. Use `[5]`.

### Asset URL

```
GET /_/v2/folds/<jobId>/<modelIndex>/<filename>
```

The whitelist is served in the 400 body for an invalid filename:

```
confidence.json, full_data.json, job_request.json,
model.cif, predicted_aligned_error.json, summary_confidences.json
```

`*.zip` is **not** served from this path — packaging goes through
`CreateDownload` (`[[[[foldId,index]]]]` → a downloadId → `GetDownload`).

---

## 6. Update / delete / rename

Request is a 2-element array `[ wrapper, FieldMask ]`. The mask string must
match **exactly** — a wrong mask is `INVALID_ARGUMENT`, not a silent no-op.

Wrapper field layout:

```
wrapper {
  1  : { 1: foldId }
  7  : { 1: displayName }     (the FoldJob body)
  12 : bool archived
}
```

| operation | mask path | verified result |
|---|---|---|
| rename | `fold_input.display_name` | name changes; read-back confirms |
| delete (archive) | `archived` | job disappears from `ListFoldJobs` |

Archiving is a soft delete. **Quota is not refunded.**

---

## 7. Login

Not OAuth2 — there is no `client_id` / `scope` / `redirect_uri`. It is Google's
`GlifWebSignIn` SSO:

```
/welcome --[Continue with Google]--> /signin
/signin  --302--> accounts.google.com/ServiceLogin
                   ?passive=1209600&osid=1
                   &continue=https://alphafoldserver.com/signin
                   &followup=https://alphafoldserver.com/signin
         --302--> accounts.google.com/v3/signin/identifier
                   ?flowName=GlifWebSignIn&flowEntry=ServiceLogin
         --[email / password / 2FA]--> redirect back to /signin
```

On success the site sets:

| cookie | domain |
|---|---|
| `NID` | `.alphafoldserver.com` |
| `__Secure-OSID` | `alphafoldserver.com` |
| `OSID` | `alphafoldserver.com` |

### Detecting "logged in"

- `OSID` **and** `__Secure-OSID` are present, **and**
- the page is no longer parked on `/welcome`

Anonymous visitors get only `NID` plus YouTube cookies and are bounced to
`/welcome`.

### Why not pure HTTP

The Google sign-in page computes its payload in JavaScript, uses reCAPTCHA and
device fingerprinting, and exposes no endpoint that trades credentials for a
token. `login.js` therefore drives a real browser and only automates the
*detection* and the *cookie export* — the human does the account step.
