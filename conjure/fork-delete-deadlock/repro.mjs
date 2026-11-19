// Shows that stock libsql-server deadlocks when a namespace fork finishes during a namespace delete, and that this
// fork's image does not. See README.md next to this file.
//
//   node conjure/fork-delete-deadlock/repro.mjs [forks per round, default 32] [trials per image, default 3]
//
// For each image (STOCK_IMAGE, then FORK_IMAGE), each trial starts a fresh private sqld (Docker), creates namespace
// `source`, then runs rounds: each round sends <forks per round> forks of `source` and, from round 2, deletes of the
// previous round's forks, all at once. A round not done within 2 s is stuck: sqld is deadlocked. A trial ends at its
// first stuck round or after MAX_ROUNDS rounds (default 2000). Each trial prints the round it got stuck on (-1: it
// finished every round) and how long it ran. Exits 0 only if every stock trial deadlocked and no fork trial did.
import { execFileSync } from 'node:child_process';

// Upstream libsql-server 0.24.33 (main @ d6c75af6), the base of this branch (.github/conjure-upstream.env).
const stockImage =
  process.env.STOCK_IMAGE ??
  'ghcr.io/tursodatabase/libsql-server@sha256:6dd3eb276d9d3604e4a48ac4a999a2e267814732d57d7e94c04ba71482333a67';
// The fork's release that Conjure pins; pass FORK_IMAGE to check another build, such as a local `docker build`.
const forkImage =
  process.env.FORK_IMAGE ??
  'ghcr.io/factory-kyle-mistele/libsql-server:0.24.33-conjure.1@sha256:92c21765923e779283e3683b019fa6e47496c52110d83ef700b5e6a88753e978';
const perRound = Number(process.argv[2] ?? 32);
const trials = Number(process.argv[3] ?? 3);
const maxRounds = Number(process.env.MAX_ROUNDS ?? 2000);
if (!(perRound > 0) || !(trials > 0) || !(maxRounds > 1)) {
  console.error('usage: [STOCK_IMAGE=<image>] [FORK_IMAGE=<image>] [MAX_ROUNDS=<n>] node repro.mjs [forks per round] [trials]');
  process.exit(2);
}

const stuckAfterMs = 2000;
const key = 'repro';
const auth = { authorization: `basic ${key}` };
const json = { ...auth, 'content-type': 'application/json' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A response other than 2xx is a failure of its own, not a deadlock.
const call = (url, init, what) =>
  fetch(url, init).then(async (response) => {
    const body = await response.text();
    if (!response.ok) throw new Error(`${what}: HTTP ${response.status} ${body}`);
  });

async function trial(image) {
  const id = execFileSync('docker', [
    'run', '--detach', '--rm', '--publish', '127.0.0.1::9090', '--tmpfs', '/var/lib/sqld',
    '--env', 'SQLD_DB_PATH=/var/lib/sqld/data.sqld', '--env', `LIBSQL_ADMIN_AUTH_KEY=${key}`,
    image,
    // The image's entrypoint adds sqld's listen flags only when the command starts with /bin/sqld, so this one names
    // them itself. `timeout` stops a sqld this script leaves behind if it dies; --rm then removes it.
    'timeout', '3600',
    '/bin/sqld', '--db-path', '/var/lib/sqld/data.sqld', '--http-listen-addr', '0.0.0.0:8080',
    '--admin-listen-addr', '0.0.0.0:9090', '--enable-namespaces', '--disable-default-namespace', '--no-welcome',
  ]).toString().trim();
  try {
    const base = `http://${execFileSync('docker', ['port', id, '9090/tcp']).toString().trim().split('\n')[0]}`;
    const readyBy = Date.now() + 60_000;
    while (!(await fetch(`${base}/v1/namespaces/source/config`, { headers: auth }).then((r) => r.status === 404, () => false))) {
      if (Date.now() > readyBy) throw new Error(`sqld (${image}) did not start within 60 s`);
      await sleep(100);
    }
    await call(`${base}/v1/namespaces/source/create`, { method: 'POST', headers: json, body: '{}' }, 'create source');

    let stuck = -1;
    let error = null;
    const start = Date.now();
    for (let round = 1; round <= maxRounds && stuck === -1; round++) {
      const signal = AbortSignal.timeout(stuckAfterMs);
      const calls = [];
      for (let i = 0; i < perRound; i++) {
        calls.push(call(`${base}/v1/namespaces/source/fork/f-${round}-${i}`, { method: 'POST', headers: json, body: '{}', signal }, `fork f-${round}-${i}`));
        if (round > 1) calls.push(call(`${base}/v1/namespaces/f-${round - 1}-${i}`, { method: 'DELETE', headers: auth, signal }, `delete f-${round - 1}-${i}`));
      }
      await Promise.all(calls).catch((cause) => {
        stuck = round;
        if (!signal.aborted) error = String(cause?.cause?.code ?? cause?.message ?? cause);
      });
    }
    return { stuck, ms: Date.now() - start, ...(error ? { error } : {}) };
  } finally {
    execFileSync('docker', ['rm', '--force', id], { stdio: 'ignore' });
  }
}

async function trialsOf(label, image) {
  const results = [];
  for (let n = 1; n <= trials; n++) {
    const result = { image: label, trial: n, ...(await trial(image)) };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  const count = (test) => results.filter(test).length;
  console.log(
    `${label} (${image}): ${perRound} forks and deletes per round, ${trials} trials: ` +
      `${count(deadlocked)} deadlocked, ${count((r) => r.stuck === -1)} finished ${maxRounds} rounds, ` +
      `${count((r) => r.error)} failed otherwise`,
  );
  return results;
}

const deadlocked = (r) => r.stuck !== -1 && !r.error;
const stock = await trialsOf('stock', stockImage);
const fork = await trialsOf('fork', forkImage);

if (stock.every(deadlocked) && fork.every((r) => r.stuck === -1)) {
  console.log('PASS: every stock trial deadlocked, and no fork trial did');
} else {
  console.log('FAIL: expected every stock trial to deadlock and every fork trial to finish');
  process.exit(1);
}
