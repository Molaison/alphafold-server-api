#!/usr/bin/env node
'use strict';

/**
 * Offline encoder check — no network, no quota.
 *
 * Each case below is a request body captured verbatim from a real logged-in
 * browser session. We rebuild the same request through the library's public
 * path (`buildReq` / `buildSubmitPayload`, the exact functions the client uses
 * at runtime) and assert the bytes match.
 *
 * Run this after ANY change to the encoder:
 *     node verify_offline.js
 */

const { buildReq, buildSubmitPayload } = require('./af3_client');

const SEQ =
  'MERPYACPVESCDRRFSRSDELTRHIRIHTGQKPFQCRICMRNFSRSDHLTTHIRTHTGEKPFACDICGRKFARSDERKRHTKIHLRQKD';

const cases = [];

// --- argument-less read -------------------------------------------------
cases.push({
  name: 'ListFoldJobs  (IbBsAc)',
  expected: '[[["IbBsAc","[]",null,"generic"]]]',
  actual: () => buildReq('IbBsAc', [{}]),
});

// --- quota read ---------------------------------------------------------
cases.push({
  name: 'GetFoldQuota  (tjI49c)',
  expected: '[[["tjI49c","[]",null,"generic"]]]',
  actual: () => buildReq('tjI49c', []),
});

// --- submit (the one that matters) --------------------------------------
cases.push({
  name: 'CreateFoldJob (kMnDgb)',
  expected:
    '[[["kMnDgb","[[\\"2026-10-20_19:24\\",[[[null,\\"' +
    SEQ +
    '\\",null,null,null,null,1,1]]]],1,[1144051370]]",null,"generic"]]]',
  actual: () =>
    buildReq(
      'kMnDgb',
      buildSubmitPayload({
        name: '2026-10-20_19:24',
        modelSeeds: [1144051370],
        sequences: [{ proteinChain: { sequence: SEQ, count: 1 } }],
      }),
    ),
});

// --- single-job read ----------------------------------------------------
cases.push({
  name: 'GetFoldJob    (EXvXWc)',
  expected: '[[["EXvXWc","[[\\"56347a534eb553ce\\"]]",null,"generic"]]]',
  actual: () => buildReq('EXvXWc', [['56347a534eb553ce']]),
});

let failed = 0;
for (const c of cases) {
  const actual = c.actual();
  const ok = actual === c.expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  if (!ok) {
    console.log(`      expected: ${c.expected}`);
    console.log(`      actual  : ${actual}`);
  }
}

console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed) {
  console.log('\nEncoder regression — do not ship this.');
  process.exit(1);
}
