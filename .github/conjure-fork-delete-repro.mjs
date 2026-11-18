// Reproduces libsql-server's metastore deadlock (a namespace fork finishing during a namespace delete) against a
// sqld image, and shows whether that image has it.
//
//   IMAGE=<image> node fork-delete-repro.mjs <forks per round> <trials>
//
// Each trial starts a fresh private sqld (Docker), creates namespace `source`, then runs rounds: each round sends
// <forks per round> forks of `source` and, from round 2, deletes of the previous round's forks, all at once. A round
// not done within 2 s is stuck: sqld is deadlocked. Each trial prints the round it got stuck on (-1: it finished
// MAX_ROUNDS rounds, default 2000) and how long it ran.
import { execFileSync } from 'node:child_process';

const image = process.env.IMAGE;
const perRound = Number(process.argv[2]);
const trials = Number(process.argv[3]);
const maxRounds = Number(process.env.MAX_ROUNDS ?? 2000);
if (!image || !(perRound > 0) || !(trials > 0)) {
  console.error('usage: IMAGE=<image> node fork-delete-repro.mjs <forks per round> <trials>');
  process.exit(2);
}

const key = 'repro';
const auth = { authorization: `basic ${key}` };
const json = { ...auth, 'content-type': 'application/json' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
for (let trial = 1; trial <= trials; trial++) {
  const id = execFileSync('docker', [
    'run', '--detach', '--rm', '--publish', '127.0.0.1::9090', '--tmpfs', '/var/lib/sqld',
    '--env', 'SQLD_DB_PATH=/var/lib/sqld/data.sqld', '--env', `LIBSQL_ADMIN_AUTH_KEY=${key}`,
    image,
    // Stops a sqld this script leaves behind if it dies; --rm then removes it.
    'timeout', '3600',
    '/bin/sqld', '--db-path', '/var/lib/sqld/data.sqld', '--http-listen-addr', '0.0.0.0:8080',
    '--admin-listen-addr', '0.0.0.0:9090', '--enable-namespaces', '--disable-default-namespace', '--no-welcome',
  ]).toString().trim();
  try {
    const base = `http://${execFileSync('docker', ['port', id, '9090/tcp']).toString().trim().split('\n')[0]}`;
    for (;;) {
      const ready = await fetch(`${base}/v1/namespaces/source/config`, { headers: auth }).then((r) => r.status === 404, () => false);
      if (ready) break;
      await sleep(100);
    }
    await fetch(`${base}/v1/namespaces/source/create`, { method: 'POST', headers: json, body: '{}' }).then((r) => r.text());

    let stuck = -1;
    let error = null;
    const start = Date.now();
    for (let round = 1; round <= maxRounds && stuck === -1; round++) {
      const signal = AbortSignal.timeout(2000);
      const calls = [];
      for (let i = 0; i < perRound; i++) {
        calls.push(fetch(`${base}/v1/namespaces/source/fork/f-${round}-${i}`, { method: 'POST', headers: json, body: '{}', signal }).then((r) => r.text()));
        if (round > 1) calls.push(fetch(`${base}/v1/namespaces/f-${round - 1}-${i}`, { method: 'DELETE', headers: auth, signal }).then((r) => r.text()));
      }
      await Promise.all(calls).catch((cause) => {
        stuck = round;
        if (!signal.aborted) error = String(cause?.cause?.code ?? cause);
      });
    }
    const result = { trial, stuck, ms: Date.now() - start, ...(error ? { error } : {}) };
    results.push(result);
    console.log(JSON.stringify(result));
  } finally {
    execFileSync('docker', ['rm', '--force', id], { stdio: 'ignore' });
  }
}
const count = (test) => results.filter(test).length;
console.log(
  `${image}: ${perRound} per round, ${trials} trials: ${count((r) => r.stuck !== -1 && !r.error)} deadlocked, ` +
    `${count((r) => r.stuck === -1)} finished ${maxRounds} rounds, ${count((r) => r.error)} failed otherwise`,
);
