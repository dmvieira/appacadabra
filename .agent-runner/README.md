# `.agent-runner/` — Deterministic Workflow Layer

This directory wires Appacadabra into [Codagent-AI/agent-runner](https://github.com/Codagent-AI/agent-runner): a Go-based workflow orchestrator that runs Claude Code (and other agent CLIs) as deterministic pipeline steps.

The point of the integration is to stop having the founder be the routing layer. Before this, "implement a feature" meant *remember* to call the UX Agent, *remember* to hand the spec to the Engineering Agent, *remember* to wake QA up, *remember* to run `npm test`, *remember* to run Maestro. After this, those steps are codified into two YAML files. The founder runs one command; the workflow keeps the order.

---

## Files

| File | Purpose |
|------|---------|
| `config.yaml` | Maps three abstract roles (`ux_role`, `eng_role`, `qa_role`) to `claude` CLI invocations. All run autonomous; Claude Code's `Agent` tool picks the actual subagent (`UX Agent`, `Engineering Agent`, `QA Agent`) from each step's prompt. |
| `workflows/feature.yaml` | UX → Engineering → QA → `npm test` → Maestro. Run when adding a feature. |
| `workflows/bugfix.yaml` | Engineering → QA regression → `npm test`. Run when fixing a bug. |

The same tests run twice in the feature workflow: once *during* `qa-validate`, where the QA Agent confirms its newly-written tests pass, and once *after*, as the deterministic `jest-rerun` / `maestro-rerun` command steps. That redundancy is the point. The agent run validates the tests *work*. The command run validates the suite *still passes* without an agent in the loop.

---

## Installation

### Linux / macOS

Download the appropriate binary from the [agent-runner releases page](https://github.com/Codagent-AI/agent-runner/releases) and place it on your `PATH`.

### Windows

Upstream v0.1.3 does not ship a Windows binary, and the upstream source does not compile on Windows out of the box. The Appacadabra fork at the `windows-port` branch adds the necessary platform splits — interactive PTY mode is stubbed (returns a clear error), but **autonomous agent steps and command steps run natively**, which is what both workflows above use.

To build the Windows port from source:

```bash
# Requires Go 1.26.1+
git clone https://github.com/Codagent-AI/agent-runner C:/tools/agent-runner
cd C:/tools/agent-runner
git checkout windows-port    # the patched branch — submit a PR upstream when ready
go build -o C:/tools/bin/agent-runner.exe ./cmd/agent-runner
# Add C:/tools/bin to your PATH
```

If Go itself is missing, the portable zip from [go.dev/dl](https://go.dev/dl/) avoids the MSI installer's UAC prompt: extract `go1.26.x.windows-amd64.zip` into any user-writable directory, then add its `bin/` to `PATH`.

---

## Invocation

```bash
# Feature workflow
agent-runner feature feature_name="quick-spell-search" description="Add a search bar above the spell list that filters by name and tags"

# Bugfix workflow
agent-runner bugfix bug_summary="Mana balance shows stale value after backgrounding the app"

# Inspect available workflows
agent-runner -list

# Validate without running
agent-runner -validate .agent-runner/workflows/feature.yaml
```

Each step launches Claude Code in autonomous mode. The session JSONL files land in `~/.claude/projects/<encoded-cwd>/` as usual, so the per-step transcripts are inspectable after the run.

---

## Why the roles are `_role` not `_agent`

The YAML key `ux_role` is an *agent-runner profile* — which CLI to spawn (`claude`) and with what flags (`model: opus, effort: high`). The actual *Claude Code subagent* (the thing defined in `.claude/agents/ux-agent.md`) is selected by the prompt content: `Agent(subagent_type="UX Agent")`. Keeping the names distinct prevents collapsing two distinct layers into one identifier.

---

## Windows port limitations

The `windows-port` branch currently has these known gaps versus the Unix builds. None block the workflows in this directory:

- **Interactive PTY mode is stubbed.** Steps with `mode: interactive` return an explicit "interactive mode is not yet supported on Windows" error. The two workflows here use autonomous mode only.
- **`skip_if: sh:...` expressions run via `cmd.exe /C`**, not `sh -c`. POSIX shell builtins are not available.
- **Inline `.sh` scripts cannot be exec'd directly.** Use `command: bash script.sh` (with WSL or git-bash on PATH) if you need shell scripts; cmd.exe `.bat` files run natively.
- **Claude Code's per-cwd session directory contains the absolute path including the `C:` drive letter**, which Windows cannot mkdir literally. This affects `~/.claude/projects/<encoded-cwd>/` and is a Claude Code path encoding question, not an agent-runner one. Sessions still work — agent-runner falls back to the run's own session UUID.

Patches to close any of these gaps are welcome upstream.
