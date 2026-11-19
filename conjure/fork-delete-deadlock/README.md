# Fork-and-delete deadlock: stock libsql-server vs this fork

[`repro.mjs`](repro.mjs) is the end-to-end proof of the metastore fix on this branch. It runs real sqld images through the admin API and shows that stock libsql-server deadlocks when a namespace fork finishes during a namespace delete, and that this fork's image does not. The unit-level proof is `flushes_and_removes_at_once_do_not_deadlock` in [`libsql-server/src/namespace/meta_store.rs`](../../libsql-server/src/namespace/meta_store.rs), which CI runs; this script is not in CI, since it hammers sqld for a few minutes.

## Run it

Needs Docker and Node 18 or later. From the repository root:

```sh
node conjure/fork-delete-deadlock/repro.mjs              # 32 forks and deletes per round, 3 trials per image
node conjure/fork-delete-deadlock/repro.mjs 8 12         # 8 per round, 12 trials per image
FORK_IMAGE=libsql-server:local node conjure/fork-delete-deadlock/repro.mjs   # a local build (docker build -t libsql-server:local .)
```

| Variable      | Default                                                               |
| ------------- | --------------------------------------------------------------------- |
| `STOCK_IMAGE` | `ghcr.io/tursodatabase/libsql-server@sha256:6dd3eb27…`, upstream 0.24.33 (`main` @ `d6c75af6`), this branch's base |
| `FORK_IMAGE`  | `ghcr.io/factory-kyle-mistele/libsql-server:0.24.33-conjure.1@sha256:92c21765…`, the release Conjure pins |
| `MAX_ROUNDS`  | `2000`                                                                |

Each trial starts a fresh private sqld on a random loopback port, creates namespace `source`, then runs rounds. Each round sends N forks of `source` and, from round 2, deletes of the previous round's N forks, all at once. A round not done within 2 s is stuck, which means sqld is deadlocked; a trial ends at its first stuck round or after `MAX_ROUNDS` rounds. Each trial prints one JSON line (`stuck` is the stuck round, or `-1` when it finished every round). The script runs every stock trial, then every fork trial, and exits 0 only if every stock trial deadlocked and no fork trial did. It removes each sqld when its trial ends; a sqld it leaves behind (if the script is killed) stops itself after an hour.

A non-2xx answer from sqld counts as `failed otherwise`, not as a deadlock, so it fails the run either way.

## Results

Default run (amd64, 4 CPUs, 2026-11-19), about 4 minutes:

```text
stock: 32 forks and deletes per round, 3 trials: 3 deadlocked (rounds 2, 2, 3), 0 finished 2000 rounds
fork:  32 forks and deletes per round, 3 trials: 0 deadlocked, 3 finished 2000 rounds (about 70 s each)
PASS: every stock trial deadlocked, and no fork trial did
```

Earlier runs of the same rounds, one image at a time (amd64, 2026-11-18):

| Forks per round | Stock: trials deadlocked | Fork: trials deadlocked |
| --------------- | ------------------------ | ----------------------- |
| 8               | 12 of 12 (rounds 3 to 76) | 0 of 12, each 2000 rounds |
| 16              | 37 of 37 (rounds 2 to 17) | 0 of 37, each 2000 rounds |
| 32              | 12 of 12 (rounds 2 to 4)  | 0 of 12, each 2000 rounds |

## When to run it

- Before releasing a new `v<version>-conjure.<n>` image, against the build: `FORK_IMAGE=<image>` (see "Release" in the root `README.md`).
- After rebasing onto a new upstream release, with `STOCK_IMAGE` set to that release's upstream image, to see whether upstream still deadlocks.
- Before dropping the fork, with `FORK_IMAGE` set to the upstream release that is meant to replace it.
