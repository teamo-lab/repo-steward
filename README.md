# Edward

Edward is a proactive repo-maintenance agent. It watches the repos you add,
runs an analysis pass over each one, proposes safe maintenance tasks, and
executes the ones you approve — all driven by shelling out to the `claude`
CLI binary.

- **Standalone.** ~1.1k LOC of Bun/TypeScript across three files. No framework.
- **In-memory state.** Zero required config, zero database.
- **gh/kubectl-style CLI.** `edward <noun> <verb>` with `--port`, `--url`, etc.
- **Dashboard + REST API.** `edward serve` starts a Bun.serve HTTP server.

## Install & run

Requires Bun `>=1.1.0` and a working `claude` CLI binary on your PATH.

```bash
./edward serve                    # dashboard on :8080
./edward serve --port 8081        # different port

./edward repos                    # list tracked repos
./edward repos add owner/repo     # verifies against GitHub before adding
./edward tasks                    # list generated maintenance tasks
./edward analyze <repo-id>        # run analysis pass
./edward run <task-id>            # execute an approved task
```

All subcommands accept an 8-character UUID prefix for repo/task IDs.

## Configuration

Every variable is optional. Edward runs with zero config.

| Variable       | Default                  | Purpose                                              |
|----------------|--------------------------|------------------------------------------------------|
| `EDWARD_PORT`  | `8080`                   | Dashboard/API port (overridden by `--port`).         |
| `EDWARD_URL`   | `http://localhost:8080`  | URL the CLI subcommands talk to.                     |
| `CLAUDE_BIN`   | auto                     | Path to the `claude` binary used for analysis.       |
| `GITHUB_TOKEN` | auto via `gh auth token` | Needed for private repos and higher rate limits.     |

See `.env.example` for the full list.

## Repository layout

```
edward                    bash launcher (exec bun src/edward/main.ts)
src/edward/main.ts        CLI entrypoint
src/edward/cli.ts         subcommand dispatch + HTTP client
src/edward/server.ts      Bun.serve dashboard + /api/v1/* endpoints
src/edward/dashboard.html
reports/                  v0.2 vs v0.3 comparison + clawschool findings
```

## Developing a new feature

Branch off `main` and PR back into `main`. There is no long-lived dev
branch — we iterate directly on `main` to keep collaboration friction low.

```bash
git fetch origin
git checkout -b feat/<short-name> origin/main
# ...work, commit...
git push -u origin feat/<short-name>
gh pr create --base main --title "feat: ..." --body "..."
```

**Do not rebase old local branches onto `main`.** The pre-v0.4.0 history
was rewritten in 2026-04 to remove vendored third-party source. Cherry-pick
the specific commits you need instead of running a full `git rebase main`.

## License

UNLICENSED — internal use only.
