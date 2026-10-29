# antigravity-executor

**English** · [简体中文](#简体中文)

Delegate coding tasks from **DeepSeek Harness (dsh)** to the **Google Antigravity**
desktop agent, using the Antigravity account you are already signed in to.

A dsh bundle plugin. It registers three tools on `ctx.tools` and runs entirely
in-process — no MCP server, no sidecar, no external dependencies, no API key.

> [!WARNING]
> **This plugin may violate Google's Antigravity terms of service.**
>
> It drives the Antigravity Language Server through its local `agentapi`
> surface, reusing the OAuth session of your signed-in desktop app. Google's
> [Antigravity Terms of Service](https://antigravity.google/terms) state:
>
> > You must not abuse, harm, interfere with, or disrupt the Service. This
> > includes, but is not limited to, using the Service in connection with
> > products not provided by us. **Using third party software, tools, or
> > services to access the Service (e.g. using OpenClaw with Antigravity OAuth)
> > is a breach of this Agreement. Such actions may be grounds for suspension
> > or termination of your Antigravity and/or Gemini CLI accounts.**
>
> You are solely responsible for the consequences of using this plugin,
> including any suspension or termination of your Google accounts. If you want
> a sanctioned path, use the [Antigravity SDK](https://github.com/google-antigravity/antigravity-sdk-python)
> with a Gemini API key or Vertex AI instead.

## Tools

| Tool | Purpose |
| --- | --- |
| `delegate_coding_task` | Hand a coding task to Antigravity; returns its report, an audited tool-call trace, a workspace audit, and any brain artifacts |
| `check_environment` | Diagnose the bridge: desktop app, port, model tiers, effective default tier, workspace policy, **live account quota with reset countdown**, git worktree pre-check, readiness (no model call) |
| `list_conversations` | List threads this plugin started (persisted, so it survives a restart) |

### `delegate_coding_task`

| Parameter | Required | Meaning |
| --- | --- | --- |
| `task_spec` | yes | Target files, required logic, edge cases, interface contracts, acceptance criteria |
| `workspace_dir` | no | Absolute path the executor may touch. **Omit to use the current dsh session's working directory** (recommended). A path outside that directory is refused unless the config sets `allowOutsideWorkspace: true`. |
| `thinking_level` | no | Per-call override: `minimal` / `low` → `flash_lite`, `medium` → `flash`, `high` / `extra_high` → `pro`. Omit to use the configured default. Ignored entirely when `allowOverride: false`. A low-quota account may be auto-downgraded from `pro` to `flash`. |
| `session_id` | no | Stable label for a feature thread; reuse it to continue the same conversation |
| `max_seconds` | no | Wall-clock budget (default from config, 900) |

## What changed in 0.5.0

0.4.0 made delegations fast, but several of its new defaults had second-order
problems that only showed up once the machinery was actually running. This
release fixes them. The first one is a genuine safety bug.

| Area | 0.4.0 behaviour | 0.5.0 |
| --- | --- | --- |
| **Kill switch** | Armed only when `failOnEscape && realtimeKillSwitch` — with the shipped `failOnEscape: false` the **80 ms circuit breaker never fired at all** | Destructive commands (`reg delete`, `diskpart`, recursive force-delete, …) are cut whenever `realtimeKillSwitch` is on, **regardless of `failOnEscape`**. Ordinary escapes still obey `failOnEscape` |
| Mid-flight audit | Merged the RPC view on every tick (correct) but had no regression test | Locked by four tests: an RPC-only violation must reach the auditor and cancel the turn |
| Quota buckets | Matched a tier row named `pro` — **no such bucket exists**, so the guard silently did nothing on a real Pro account | Binds the shared `Gemini Models` pool by name/shape; takes the tighter of the tier row and the `gemini-5h` bucket |
| Weekly quota | Same 5% threshold as the 5h window | Separate, higher reserve (`weeklyProMinFraction: 0.15`), skipped when the reset is under 24h away — a drained week costs days, a drained 5h window costs hours |
| Quota reads | One `GetUserStatus` per delegation | 3-minute cache, abandoned near the guard threshold; `check_environment` always reads live |
| Consecutive turns | Could fire 1–2 s apart after the 45 s tax was removed | Inter-turn pacing: minimum gap plus jitter, applied **only before the next turn starts** |
| Dev servers | `npm run dev` / bare `vitest` silently burned the full 900 s budget | Forbidden in the preamble and the bundled skill; the auditor recognises hanging commands and warns with the elapsed time |
| Artifacts | Fixed 600-char summary, or unbounded inline after 0.4.0 turned on the full transcript | `maxArtifactInlineChars: 4000`: short files inline verbatim, long ones inline a head **plus their absolute path** so the planner reads the rest on demand |
| Dead sessions | A persisted mapping outlived its conversation and failed forever | Evicted on the first dead turn, then a fresh conversation is opened and the record is rewritten |
| Long sessions | No signal that a session was getting expensive | `turn_count` per session; a hint appears past `longSessionTurns` (default 8) |

### The kill-switch bug (read this one)

`realtimeKillSwitch` and `failOnEscape` are not the same kind of switch, and
0.4.0 wired the breaker to both. `failOnEscape` answers "should an out-of-workspace
*escape* fail this turn?" — one legitimate answer is `false`, because the executor
sometimes reads a reference file outside the project. But the breaker was gated on
the same flag, so the shipped default left it disarmed. A `reg delete` or a
`Remove-Item -Recurse -Force` would have been *reported* afterwards, never *stopped*.

0.5.0 splits the verdict:

```js
const verdict = auditor.push(step)
verdict.blockedDestructive  // reg delete, diskpart, rd /s /q, ri -Recurse, …  -> cut on realtimeKillSwitch alone
verdict.blockedEscape       // cd-outside, write-outside                     -> still needs failOnEscape
```

`classifyFinding(kind)` is the exported rule behind those two flags.

### Pacing is not a turn delay

`pacing.minGapSeconds` never slows down a turn you are waiting for. The result
still comes back as fast as the RPC reports IDLE. What the pacer does is top up
the gap before the *next* delegation when the previous one ended moments ago, with
a jittered delay so the gaps are not metronome-regular. It is a mitigation for one
specific signature (zero-think-time re-dispatch against a real signed-in account),
not a guarantee of looking organic.

## What changed in 0.4.0

The 0.3.0 plugin worked, but every delegation carried a fixed 45-second tax, long
reports were silently cut off, the account's remaining quota was invisible, and
the audit could only complain *after* a turn had already escaped. This release
fixes all four, plus resilience and cross-platform support.

| Area | Before | After |
| --- | --- | --- |
| Turn settlement | Always waited out `quietWindowSeconds: 45` | Settles on the Language Server's own RPC state — **measured 8.4s wall clock for a turn that used to cost 45s+** |
| Long reports | Fields over ~4000 chars truncated with `truncated_fields` | Reads `transcript_full.jsonl`, falls back to the untruncated RPC steps |
| Quota | Invisible | `check_environment` shows every tier's remaining fraction and reset countdown; `pro` auto-downgrades to `flash` below a threshold |
| Escapes | Reported after the turn | Streamed audit with a mid-flight `CancelCascadeInvocation` kill switch |
| Audit bypass | `cd ..\..`, `sl`, `ri`, `$env:TEMP` slipped through | Virtual working-directory state machine + alias/environment expansion |
| Sessions | Lost on restart | Persisted `session_id → conversation_id` map |
| Desktop restart | Stale port/token until dsh restarted | Automatic re-discovery on `ECONNREFUSED` / 401 / 403 |
| Dead turns | Ran to the deadline, reported "timeout", CLEAN audit | Fails in ~0.1s with the executor's real error text |
| Platforms | Windows-only PowerShell assumptions | Windows / macOS / Linux discovery and shell preambles |

### Turn settlement (the 45-second fix)

`WaitForConversationFullyIdle` is a real long poll: it blocks while the agent is
busy and returns in ~34 ms once the cascade is idle. Settlement uses that instead
of a fixed quiet window, then confirms `CASCADE_RUN_STATUS_IDLE` plus the
trajectory's `terminationReason`, and requires a tool-call-free planner message
plus a short `fastSettleSeconds` window so the brief gap between two tool rounds
is not mistaken for the end.

Two traps this deliberately handles:

- **"Last step is a PLANNER_RESPONSE" is not a completion test.** A background
  `run_command` emits a planner message first and reports completion later via a
  `SYSTEM_MESSAGE`, so completion is decided by the cascade status.
- **The brain log lags the server.** A finished turn can still show only its
  `USER_INPUT` on disk while the RPC already has the final steps, so the
  settlement read merges the RPC view over the file.

`quietWindowSeconds` remains only as the fallback used when the long poll is
unavailable (method missing, or a non-timeout transport failure).

### Quota-aware fallback

`check_environment` reports the account plan and, per tier and per window
(5-hour / weekly), the remaining fraction and reset countdown:

```
quota        : plan=Pro (you@example.com)
  buckets:
    Gemini Models / gemini-5h (5h): 99%, resets in 4h 23m
    Gemini Models / gemini-weekly (weekly): 98%, resets in 1d 5h
```

With `quotaFallback.enabled`, a `pro` delegation whose remaining fraction is
below `proMinFraction` runs on `flash` instead, and the report says so
(`downgraded: pro -> flash (low quota)`). When the tier cannot be identified the
plugin keeps the requested tier rather than guessing — a parse failure must not
silently downgrade a task.

### Streaming audit and the kill switch

The auditor is stateful: it is fed one step at a time while the turn runs, so
`push()` can return `blocked` and the turn can be cancelled mid-flight. It also
tracks a **virtual working directory** across the turn, so `cd ../..` in one
step makes `../../secret.txt` in the next resolve to the path it really touches,
and it expands PowerShell/Bash aliases (`sl`, `ri`, `pushd`) and environment
variables (`$env:USERPROFILE`, `$env:TEMP`, `~`) before classifying.

Keep `realtimeKillSwitch: true` (the default) to turn a *destructive command*
finding into an immediate cancellation — this no longer depends on
`failOnEscape`, because tolerating an out-of-workspace read was never meant to
mean tolerating `reg delete`. Add `failOnEscape: true` as well if you want plain
workspace escapes (`cd-outside`, `write-outside`) to interrupt the turn too.

This is a real interrupt, not a post-hoc verdict: measured,
`CancelCascadeInvocation` moves the cascade to `IDLE` / `USER_CANCELED` within
~80 ms.

It is still an auditor, not a sandbox. See the limitations section.

## Configuration: thinking level, workspace policy, settlement and safety

Every tunable lives in the bundle patch, so it survives upgrades and applies
immediately on profiles with HMR enabled. Edit the `config` block of
`id: antigravity-executor` in your profile's `cordis.patch.yml` (or the copy
shipped in this package's `cordis.patch.yml`):

```yaml
- insert:
    - id: antigravity-executor
      name: 'antigravity-executor'
      config:
        thinkingLevel: medium        # minimal | low | medium | high | extra_high
        allowOverride: true          # let a call pass thinking_level
        followSessionWorkspace: true # workspace_dir optional, follows the session cwd
        allowOutsideWorkspace: false # refuse a workspace outside the session cwd
        audit: true                  # classify every tool call against the workspace
        failOnEscape: false          # true = reject the result when the audit finds an escape
        maxSeconds: 900

        # Turn settlement (REQ-01)
        pollIntervalSeconds: 2       # scan cadence while the turn runs
        fastSettleSeconds: 2         # confirmation window after the server reports IDLE
        quietWindowSeconds: 45       # fallback only, when the long poll is unavailable

        # Anti-truncation (REQ-02)
        useFullTranscript: true      # prefer transcript_full.jsonl

        # Quota guard (REQ-03)
        quotaFallback:
          enabled: true
          proMinFraction: 0.05       # downgrade pro -> flash below 5% remaining (5h window)
          weeklyProMinFraction: 0.15 # higher reserve for the weekly window
          weeklyGuard: true
          weeklyReserveHours: 24     # skip the weekly guard once the reset is this close
          cacheTtlSeconds: 180       # reuse a quota read this long (0 = off)

        # Safety, persistence, artifacts (REQ-04/06/07 + v0.5.0)
        realtimeKillSwitch: true     # destructive commands always cut, regardless of failOnEscape
        persistSessions: true        # dead mappings are evicted automatically
        includeBrainArtifacts: true
        maxArtifactInlineChars: 4000 # longer .md files inline a head + their absolute path
        maxArtifactHeadChars: 2000
        longSessionTurns: 8          # suggest a fresh session_id past this many turns
        hangingCommandWarnSeconds: 45 # warn about dev servers / watch processes after this long

        # Human-like pacing (v0.5.0) — delays only the start of the NEXT turn
        pacing:
          enabled: true
          minGapSeconds: 15
          jitterMinSeconds: 6
          jitterMaxSeconds: 15
```

Every key is optional and defaults are restated above, so a 0.3.0 profile keeps
loading unchanged.

`thinkingLevel` is the selector: set it once and every delegation uses that
tier. It defaults to `medium` (`flash`). The original release defaulted to
`high` (`pro`) because `flash_lite` produces noticeably sloppier code — for
example stray commas in signatures — so raise it to `high` when correctness
matters more than latency, and use `low` only for trivial edits.

## Workspace: follows the session, audited afterwards

`delegate_coding_task` defaults its workspace to the **current dsh session's
working directory**, read from the session header. Omit `workspace_dir` and the
executor works where the conversation works. Passing a path outside that
directory is refused unless `allowOutsideWorkspace: true`, so a typo in a task
spec cannot aim the executor at `C:\Windows`.

**This is a soft sandbox, not kernel-enforced containment.** Antigravity's
`agentapi` offers no workspace parameter: a conversation created through it
carries `workspaces: []` and `enforcedWorkspaceValidation: false` in its own
metadata, so the executor's filesystem reach is decided by the model's
cooperation. What this plugin adds is an **auditor**: it reads the transcript,
classifies each `read_file` / `run_command` against the workspace, and appends a
verdict to the report:

```
--- workspace audit (soft sandbox) ---
workspace    : C:\projects\demo
activity     : 1 command(s), 0 read(s), 0 write-shaped command(s)
verdict      : CLEAN - no out-of-workspace access detected in the transcript
```

It flags three families of finding: writes outside the workspace, a
`Set-Location` that leaves it, and destructive commands (`format`, `diskpart`,
recursive deletes, wildcard deletes, `reg delete`, remote-script piping, and the
PowerShell alias spellings of all of the above). Reads of Antigravity's own guide
files are listed separately as benign context rather than violations.

The audit runs **during** the turn as well as after it. With the default
`realtimeKillSwitch: true`, a destructive command cancels the cascade mid-flight;
add `failOnEscape: true` to have plain workspace escapes interrupt it too. That
is the closest thing to containment available through this surface — a determined
executor is still not physically stopped, so always review the diff and run the
verification yourself.

## Bundled skill: `supervisor-workflow`

The package ships a workflow skill that turns the calling model into a
**planner/supervisor** and the executor into the only writer:

- the model may read the codebase with its own tools, but must not edit
  business source itself — every change goes through `delegate_coding_task`
- dispatches must carry absolute paths plus the `Set-Location` /
  PowerShell preamble, or the executor wastes a minute running commands in
  Antigravity's install directory
- the supervisor must **verify independently** after every delegation: read the
  diff, run the tests, and never accept the executor's self-report as a result
- three consecutive failed review rounds is a hard stop that hands the decision
  back to the human

The skill registers itself through `ctx.skills`, so it appears exactly where the
plugin is enabled and disappears when the bundle is toggled off. Its body lives
at `skills/supervisor-workflow/SKILL.md` and ships with the package — the
workflow and the tools it drives cannot drift apart across upgrades.

You do not need to install or configure anything extra; invoke it by name if
your harness supports skill invocation, or simply tell the model to follow it.

## How it works

The plugin talks to Antigravity through three channels:

1. `language_server.exe agentapi` — start a conversation, send a message. `execFile`
   passes argv without a shell, so multi-line prompts and embedded quotes survive
   intact.
2. `~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl`
   — the untruncated turn log, used for the report and the audit.
3. The Language Server's own **ConnectRPC** surface (`POST /exa.language_server_pb.LanguageServerService/<Method>`)
   — `WaitForConversationFullyIdle` for settlement, `GetCascadeTrajectory` /
   `GetAllCascadeTrajectories` for state, `GetUserStatus` /
   `RetrieveUserQuotaSummary` for quota, `GetCascadeTrajectorySteps` as the
   untruncated transcript fallback, and `CancelCascadeInvocation` for the kill
   switch. Every call carries `X-Codeium-Csrf-Token` and `Connect-Protocol-Version: 1`.

Discovery is platform-specific: Windows enumerates `language_server*.exe` via
`Get-CimInstance Win32_Process` and reads ports from `netstat -ano`; macOS/Linux
use `ps -ax -o pid=,command=` and `lsof -nP -iTCP -sTCP:LISTEN` (falling back to
`ss -tlnp`). The CSRF token comes from the process command line. Results are
cached and revalidated with a cheap probe, and a cached identity is dropped
automatically on `ECONNREFUSED` / 401 / 403, so restarting the desktop app does
not require restarting dsh.

A turn settles when the server reports `CASCADE_RUN_STATUS_IDLE` with a terminal
`terminationReason` **and** a tool-call-free planner message exists **and** a
short confirmation window passes with no new step.

Override the Language Server path with `AGY_LANGUAGE_SERVER` if Antigravity is
installed somewhere unusual.

## Install

This is a dsh **bundle plugin**, installed with `dsh plugin … add`. Pick whichever
form matches how dsh is installed on your machine.

### From npm (recommended)

```bash
dsh plugin --profile <profile> add antigravity-executor
```

Replace `<profile>` with your profile name — `web` for a plain `dsh web`
install, or `tauri` for the desktop app. The command forwards `add` to pnpm in
the profile directory and appends the package to `dsh.profile.bundles`.

If `dsh` is not on your `PATH`, call the launcher directly from the dsh
installation directory:

```bash
# Desktop app install
node node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile tauri add antigravity-executor

# Or via npx
npx -y @deepseek-ai/dsh plugin --profile web add antigravity-executor
```

### From a local checkout

Useful when hacking on the plugin itself — a `link:` dependency points at your
working copy, so edits take effect without reinstalling:

```bash
git clone https://github.com/wuyu1327083461/antigravity-executor.git
dsh plugin --profile <profile> add "link:$(pwd)/antigravity-executor"
```

On Windows PowerShell:

```powershell
git clone https://github.com/wuyu1327083461/antigravity-executor.git
dsh plugin --profile tauri add "link:F:/path/to/antigravity-executor"
```

### Verify and enable

```bash
# The row should appear in the composed config
dsh --profile <profile> --dump-config   # look for `id: antigravity-executor`
```

Then enable it in the dsh Web UI: **Plugins → Installed plugins → Antigravity
Executor**. Toggling it off unregisters the tools; nothing is spawned either
way, so there is no process to kill. The switch writes
`disabled: true|false` for `id: antigravity-executor` into the profile's
`cordis.patch.yml` and takes effect immediately on profiles with HMR enabled.

### Uninstall

```bash
dsh plugin --profile <profile> remove antigravity-executor
```

That drops the dependency and the bundle entry. The plugin keeps no state
outside its own directory (`sessions.json` lives there and is gitignored).

## Requirements

- **Antigravity desktop app running and signed in** (minimised is fine — it
  must not be quit). No API key is involved.
- Node.js ≥ 22.19.0 (whatever dsh itself needs)

## Known limitations

**There is no kernel-enforced filesystem sandbox.** `agentapi` creates
conversations with `workspaces: []` and `enforcedWorkspaceValidation: false`,
so "only touch this directory" is a prompt-level guard plus an auditor, not
containment. The plugin injects a preamble into every dispatched task (absolute
paths, the per-platform working-directory prefix, shell syntax notes) and then
verifies what actually happened, cancelling mid-flight when configured to do so,
but a determined executor is not physically stopped.

`run_command` executes in **PowerShell** on Windows and a POSIX shell elsewhere,
and its default working directory is the Antigravity install directory, not your
project — which is why the `Set-Location` / `cd` prefix in the preamble is
mandatory rather than decorative.

Because of the above, always review the diff and run the verification yourself
after a delegation. The tool returns an audited tool-call trace and a workspace
verdict to make that easy, and the model's self-report should be treated as a
claim, not a result.

**Region restrictions are the backend's, not the plugin's.** Antigravity's
service can answer `FAILED_PRECONDITION (code 400): User location is not
supported for the API use.` The plugin surfaces that text verbatim and fails
within a few seconds instead of burning the whole `maxSeconds` budget, but it
cannot route around it.

**A turn the server reports as finished but the disk log has not yet flushed is
read through RPC.** That is the settlement path; the final report still prefers
the on-disk transcript, which carries the complete historical turn.

## Development

```bash
npm test                      # node --test lib/*.test.js
node --test lib/turn.test.js  # one module
```

Tests never touch Antigravity: the RPC client, transcript reader and clock are
injectable, so every settlement path (rpc-idle, quiet-window fallback, kill
switch, timeout, executor-error) is exercised deterministically. `CONTRACT.md`
records the module interfaces and the measured RPC facts the implementation
depends on.

## License

MIT. See the warning at the top: the licence covers this code, not your
compliance with anyone else's terms.

---

# 简体中文

[English](#antigravity-executor) · **简体中文**

把编码任务从 **DeepSeek Harness（dsh）** 委派给 **Google Antigravity 桌面端**，
复用你已经登录的 Antigravity 账号额度。

这是一个 dsh bundle 插件。它在 `ctx.tools` 上注册三个工具，全部在进程内运行
——没有 MCP 服务、没有旁路进程、没有外部依赖、不需要 API Key。

> [!WARNING]
> **本插件可能违反 Google Antigravity 的服务条款。**
>
> 它通过本地 `agentapi` 接口驱动 Antigravity Language Server，复用桌面端已登录
> 的 OAuth 会话。Google 的
> [Antigravity 服务条款](https://antigravity.google/terms) 明确写明：
>
> > 你不得滥用、损害、干扰或破坏本服务，包括但不限于将本服务与并非由我们提供的
> > 产品结合使用。**使用第三方软件、工具或服务访问本服务（例如用 OpenClaw 搭配
> > Antigravity OAuth）即违反本协议，可能导致你的 Antigravity 和/或 Gemini CLI
> > 账号被暂停或终止。**
>
> 使用本插件的一切后果由你自行承担，包括 Google 账号被暂停或终止。若需要合规
> 路径，请改用 [Antigravity SDK](https://github.com/google-antigravity/antigravity-sdk-python)
> 配合 Gemini API Key 或 Vertex AI。

## 工具

| 工具 | 用途 |
| --- | --- |
| `delegate_coding_task` | 把编码任务交给 Antigravity；返回它的报告、经审计的工具调用轨迹、工作区审计结论，以及它产出的 brain 产物 |
| `check_environment` | 诊断桥接状态：桌面端、端口、模型档位、默认档位、工作区策略、**账号实时额度与重置倒计时**、git worktree 预检、可用性（不产生模型调用） |
| `list_conversations` | 列出本插件发起过的会话线程（已落盘，重启后仍可见） |

### `delegate_coding_task`

| 参数 | 必填 | 含义 |
| --- | --- | --- |
| `task_spec` | 是 | 目标文件、所需逻辑、边界条件、接口契约、验收标准 |
| `workspace_dir` | 否 | 执行器可触碰的绝对路径。**省略则使用当前 dsh 会话的工作目录**（推荐）。位于该目录之外的路径会被拒绝，除非配置里设了 `allowOutsideWorkspace: true`。 |
| `thinking_level` | 否 | 单次覆盖：`minimal` / `low` → `flash_lite`，`medium` → `flash`，`high` / `extra_high` → `pro`。省略则用配置默认档位；当 `allowOverride: false` 时该参数被完全忽略。额度不足时可能被自动从 `pro` 降级到 `flash`。 |
| `session_id` | 否 | 功能线程的稳定标签；复用同一个值即可在返工轮次里延续同一会话 |
| `max_seconds` | 否 | 本次委派的墙钟预算（默认取配置值 900） |

## 0.5.0 更新内容

0.4.0 把委派变快了，但它引入的几个新默认值在机器真正跑起来之后暴露出二阶问题。
本次发布把它们全部修掉。其中第一条是实打实的安全缺陷。

| 方面 | 0.4.0 行为 | 0.5.0 |
| --- | --- | --- |
| **熔断开关** | 只有 `failOnEscape && realtimeKillSwitch` 同时为真才武装——而默认 `failOnEscape: false`，于是**80ms 事中熔断从未触发过** | 破坏性命令（`reg delete`、`diskpart`、递归强删等）只要 `realtimeKillSwitch` 开着就熔断，**无视 `failOnEscape`**；普通越界仍受 `failOnEscape` 控制 |
| 事中审计 | 每个 tick 都合并 RPC 视图（原本就正确）但没有回归测试锁住 | 四条测试锁定：仅存在于 RPC 的违规必须送达审计器并取消回合 |
| 配额桶 | 按名字找 `pro` 档——**真实账号根本没有这个桶**，保护静默失效 | 按名称/形状绑定共享的 `Gemini Models` 池；tier 行与 `gemini-5h` 桶取更紧者 |
| 周限额 | 与 5h 窗口共用 5% 阈值 | 独立更高水位（`weeklyProMinFraction: 0.15`），距重置不足 24 小时则不启用——周限额用光要等几天，5h 桶只需几小时 |
| 配额读取 | 每次委派都实时查一次 `GetUserStatus` | 3 分钟缓存，逼近警戒线自动放弃；`check_environment` 始终实时 |
| 连续回合 | 45 秒税取消后可能 1~2 秒无缝连发 | 回合间拟人冷却：最小间隔 + 抖动，**只作用于下一轮开始前** |
| 常驻命令 | `npm run dev` / 裸 `vitest` 会静默烧完 900 秒预算 | Preamble 与内置技能双重禁止；审计器识别常驻命令并按已持续秒数告警 |
| Brain 产物 | 固定 600 字符摘要，或 0.4.0 开启全量后无上限内联 | `maxArtifactInlineChars: 4000`：短文件全文内联，长文件只内联开头 **+ 绝对路径**，需要细节时主模型自己读 |
| 失效会话 | 持久化映射活得比会话久，永久失败 | 首次 dead turn 即剔除，随后自动开新会话并重写记录 |
| 长会话 | 没有任何「越来越贵」的信号 | 每个会话记 `turn_count`，超过 `longSessionTurns`（默认 8）给出提示 |

### 熔断逻辑的缺陷（这一条请重点看）

`realtimeKillSwitch` 和 `failOnEscape` 不是同一类开关，0.4.0 却把熔断器同时拴在两者上。
`failOnEscape` 回答的是「越界**逃逸**要不要判本轮失败」——答 `false` 完全合理，因为执行器
偶尔需要读项目外的参考文件。但熔断器被同一个标志卡住，于是默认配置下它根本没有武装。
一条 `reg delete` 或 `Remove-Item -Recurse -Force` 只会被**事后报告**，永远不会被**当场拦下**。

0.5.0 把结论拆成两个粒度：

```js
const verdict = auditor.push(step)
verdict.blockedDestructive  // reg delete、diskpart、rd /s /q、ri -Recurse …  -> 只看 realtimeKillSwitch
verdict.blockedEscape       // cd-outside、write-outside                    -> 仍需 failOnEscape
```

`classifyFinding(kind)` 就是这两个标志背后的导出规则。

### 冷却不会拖慢回合

`pacing.minGapSeconds` 绝不会让你正在等的这一轮变慢——结果依然在 RPC 报 IDLE 的瞬间返回。
冷却做的是：当上一轮刚刚结束就立刻又收到委派时，补足间隔，并叠加随机抖动，避免间隔过于规整。
它是针对**单一特征**（对真实登录账号的「零思考时间」连发）的缓解手段，不是「伪装成人类」的保证。

## 0.4.0 更新内容

0.3.0 是能用的，但每次委派都固定多付 45 秒、长报告被静默截断、账号剩余额度
完全不可见、审计只能在回合已经越界**之后**才报警。本次发布把这四点全部修掉，
并补上了抗毁性与跨平台支持。

| 方面 | 之前 | 现在 |
| --- | --- | --- |
| 回合结算 | 永远等满 `quietWindowSeconds: 45` | 依据 Language Server 自身的 RPC 状态结算 —— **实测一个原本 45 秒以上的回合 8.4 秒返回** |
| 长报告 | 超过约 4000 字符的字段被截断并打 `truncated_fields` | 读取 `transcript_full.jsonl`，缺失时用未截断的 RPC 步骤兜底 |
| 额度 | 不可见 | `check_environment` 展示各档位剩余比例与重置倒计时；`pro` 低于阈值时自动降级 `flash` |
| 越界 | 回合结束后才报告 | 流式审计 + 事中 `CancelCascadeInvocation` 熔断 |
| 审计绕过 | `cd ..\..`、`sl`、`ri`、`$env:TEMP` 都能溜过去 | 虚拟工作目录状态机 + 别名/环境变量展开 |
| 会话 | 重启即丢失 | `session_id → conversation_id` 映射落盘 |
| 桌面端重启 | 端口/令牌失效，必须重启 dsh | 遇到 `ECONNREFUSED` / 401 / 403 自动重发现 |
| 死掉的回合 | 跑到超时，报「timeout」，审计还是 CLEAN | 约 0.1 秒失败，并回传执行器的真实错误文本 |
| 平台 | 硬编码 PowerShell，仅 Windows | Windows / macOS / Linux 的发现逻辑与 shell 前置解耦 |

### 回合结算（那个 45 秒的修复）

`WaitForConversationFullyIdle` 是真正的长轮询：agent 忙时它阻塞，cascade 一空闲
它约 34 毫秒就返回。结算改用这个接口而不是固定静默窗口，然后再确认
`CASCADE_RUN_STATUS_IDLE` 与该轨迹的 `terminationReason`，并要求存在一条不带
工具调用的 planner 消息，外加一个短暂的 `fastSettleSeconds` 确认窗口，避免把两轮
工具之间的间隙误判成结束。

这里刻意处理了两个坑：

- **「最后一步是 PLANNER_RESPONSE」不是结束判据。** 后台 `run_command` 会先发一条
  planner 消息，稍后再通过 `SYSTEM_MESSAGE` 回报完成，所以结束与否由 cascade
  状态决定。
- **brain 日志滞后于服务端。** 一个已经结束的回合，磁盘上可能只有 `USER_INPUT`，
  而 RPC 已经有最终步骤，因此结算读取会用 RPC 视图覆盖磁盘视图。

`quietWindowSeconds` 仅作为长轮询不可用时（方法缺失，或非超时的传输失败）的兜底。

### 额度感知降级

`check_environment` 会报告账号套餐，并按档位、按窗口（5 小时 / 每周）给出剩余比例
与重置倒计时：

```
quota        : plan=Pro (you@example.com)
  buckets:
    Gemini Models / gemini-5h (5h): 99%, resets in 4h 23m
    Gemini Models / gemini-weekly (weekly): 98%, resets in 1d 5h
```

开启 `quotaFallback.enabled` 后，若一次 `pro` 委派的剩余比例低于
`proMinFraction`，会自动改用 `flash` 执行，并在报告里注明
（`downgraded: pro -> flash (low quota)`）。当档位无法识别时，插件保持你请求的
档位而不是猜一个 —— 解析失败绝不能变成静默降级。

### 流式审计与熔断

审计器是有状态的：回合运行期间它按步骤被逐步喂入，因此 `push()` 能返回
`blocked`，让回合在途中被取消。它还会在整轮内跟踪**虚拟工作目录**，所以某一步的
`cd ../..` 会让下一步的 `../../secret.txt` 解析成它真正触碰的路径；同时会先展开
PowerShell/Bash 别名（`sl`、`ri`、`pushd`）与环境变量（`$env:USERPROFILE`、
`$env:TEMP`、`~`）再判定。

保持 `realtimeKillSwitch: true`（默认值），命中**高危破坏性命令**就会立即取消——
这一条已经不再依赖 `failOnEscape`，因为「容忍偶尔读工作区外的文件」从来不该等于
「容忍 `reg delete`」。如果还想让普通越界（`cd-outside`、`write-outside`）也中断回合，
再额外设 `failOnEscape: true`。

这是真正的中断，不是事后判定：实测 `CancelCascadeInvocation` 约 80 毫秒内
把 cascade 置为 `IDLE` / `USER_CANCELED`。

它仍然只是审计器，不是沙箱。见下文限制说明。

## 配置：思考档位、工作区策略、结算与安全

所有可调项都写在 bundle patch 里，因此能跨升级保留，并在开启 HMR 的 profile 上
即时生效。编辑 profile 的 `cordis.patch.yml` 中 `id: antigravity-executor` 的
`config` 块（或本包自带的 `cordis.patch.yml`）：

```yaml
- insert:
    - id: antigravity-executor
      name: 'antigravity-executor'
      config:
        thinkingLevel: medium        # minimal | low | medium | high | extra_high
        allowOverride: true          # 允许单次调用传 thinking_level
        followSessionWorkspace: true # workspace_dir 可省略，跟随会话 cwd
        allowOutsideWorkspace: false # 拒绝会话工作区之外的 workspace
        audit: true                  # 把每次工具调用对照工作区分类
        failOnEscape: false          # true = 审计发现越界即判定结果不可采纳
        maxSeconds: 900

        # 回合结算 (REQ-01)
        pollIntervalSeconds: 2       # 回合运行期间的扫描节奏
        fastSettleSeconds: 2         # 服务端报 IDLE 后的确认窗口
        quietWindowSeconds: 45       # 仅作兜底，长轮询不可用时才用

        # 反截断 (REQ-02)
        useFullTranscript: true      # 优先 transcript_full.jsonl

        # 额度保护 (REQ-03)
        quotaFallback:
          enabled: true
          proMinFraction: 0.05       # 5h 窗口：pro 剩余低于 5% 时降级 flash
          weeklyProMinFraction: 0.15 # 周限额用更高水位单独保护
          weeklyGuard: true
          weeklyReserveHours: 24     # 距重置不足这么多小时则不启用周保护
          cacheTtlSeconds: 180       # 配额缓存秒数（0 = 关闭）

        # 安全、持久化、产物 (REQ-04/06/07 + v0.5.0)
        realtimeKillSwitch: true     # 破坏性命令无条件熔断，与 failOnEscape 无关
        persistSessions: true        # 失效映射会自动剔除
        includeBrainArtifacts: true
        maxArtifactInlineChars: 4000 # 更长的 .md 只内联开头 + 绝对路径
        maxArtifactHeadChars: 2000
        longSessionTurns: 8          # 超过这么多轮提示换新 session_id
        hangingCommandWarnSeconds: 45 # dev server / watch 持续这么久后告警

        # 拟人冷却 (v0.5.0) —— 只延迟「下一轮」的开始
        pacing:
          enabled: true
          minGapSeconds: 15
          jitterMinSeconds: 6
          jitterMaxSeconds: 15
```

每个键都可选，默认值已在上方重述，因此 0.3.0 的 profile 可原样加载。

`thinkingLevel` 是选择器：设一次，之后每次委派都用该档位，默认 `medium`
（`flash`）。最初版本默认 `high`（`pro`），因为 `flash_lite` 产出的代码明显更潦草
（例如函数签名里冒出多余逗号）——所以正确性优先于延迟时把它调到 `high`，而
`low` 只用于琐碎改动。

## 工作区：跟随会话，事后审计

`delegate_coding_task` 默认把工作区设为**当前 dsh 会话的工作目录**（从会话头读取）。
省略 `workspace_dir`，执行器就在对话所在的地方干活。位于该目录之外的路径会被
拒绝，除非 `allowOutsideWorkspace: true`，这样一个任务规格里的笔误就不会把执行器
指向 `C:\Windows`。

**这是软沙箱，不是内核级隔离。** Antigravity 的 `agentapi` 不提供工作区参数：通过
它创建的会话在自己的元数据里就写着 `workspaces: []` 和
`enforcedWorkspaceValidation: false`，所以执行器能碰什么由模型是否配合决定。本插件
补上的是一个**审计器**：它读取 transcript，把每次 `read_file` / `run_command` 对照
工作区分类，并把结论附在报告末尾：

```
--- workspace audit (soft sandbox) ---
workspace    : C:\projects\demo
activity     : 1 command(s), 0 read(s), 0 write-shaped command(s)
verdict      : CLEAN - no out-of-workspace access detected in the transcript
```

它标记三类发现：在工作区之外写入、把工作目录切到工作区之外、以及破坏性命令
（`format`、`diskpart`、递归删除、通配删除、`reg delete`、远程脚本管道，以及上述
命令的 PowerShell 别名写法）。读取 Antigravity 自身的指南文件会单独列为无害上下文，
而不是违规。

审计**在回合运行期间**就会执行，而不只是事后。默认的 `realtimeKillSwitch: true`
会让破坏性命令当场取消 cascade；若想让普通工作区越界也中断，再设
`failOnEscape: true`。这是通过该接口能拿到的最接近「隔离」的东西 —— 铁了心的
执行器依然不会被物理拦住，所以务必自己复核 diff 并亲自跑验证。

## 内置技能：`supervisor-workflow`

本包附带一个工作流技能，把调用方模型变成**总策划/验收官**，把执行器变成唯一的
写入者：

- 模型可以用自己的工具读代码库，但不得亲自编辑业务源码 —— 所有改动都走
  `delegate_coding_task`
- 派单必须带绝对路径与 `Set-Location` / PowerShell 前置，否则执行器会把一分钟浪费
  在 Antigravity 的安装目录里跑命令
- 每次委派后必须**独立验收**：读 diff、跑测试，绝不把执行器的自述当结果
- 连续三轮验收失败是硬性停止点，把决定权交回人类

该技能通过 `ctx.skills` 注册，因此只在插件启用的地方出现，bundle 关掉就消失。它的
正文放在 `skills/supervisor-workflow/SKILL.md` 并随包发布 —— 工作流与它驱动的工具
不会在升级中走散。

你无需额外安装或配置；如果你的 harness 支持技能调用，按名字调用即可，或者直接让
模型照着做。

## 工作原理

插件通过三条通道与 Antigravity 通信：

1. `language_server.exe agentapi` —— 创建会话、发送消息。`execFile` 不经过 shell
   传递 argv，所以多行 prompt 与内嵌引号都能原样保留。
2. `~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl`
   —— 未截断的回合日志，用于报告与审计。
3. Language Server 自身的 **ConnectRPC** 接口
   （`POST /exa.language_server_pb.LanguageServerService/<Method>`）——
   `WaitForConversationFullyIdle` 用于结算，`GetCascadeTrajectory` /
   `GetAllCascadeTrajectories` 用于状态，`GetUserStatus` /
   `RetrieveUserQuotaSummary` 用于额度，`GetCascadeTrajectorySteps` 作为未截断
   transcript 的兜底，`CancelCascadeInvocation` 用于熔断。每次调用都带
   `X-Codeium-Csrf-Token` 与 `Connect-Protocol-Version: 1`。

服务发现按平台区分：Windows 用 `Get-CimInstance Win32_Process` 枚举
`language_server*.exe`，再用 `netstat -ano` 读端口；macOS/Linux 用
`ps -ax -o pid=,command=` 与 `lsof -nP -iTCP -sTCP:LISTEN`（退化到 `ss -tlnp`）。
CSRF 令牌从进程命令行解析。结果会缓存并用廉价探针复验，缓存身份在遇到
`ECONNREFUSED` / 401 / 403 时自动丢弃，因此重启桌面端不需要重启 dsh。

当服务端报告 `CASCADE_RUN_STATUS_IDLE` 且带终态 `terminationReason`、**并且**存在
不带工具调用的 planner 消息、**并且**一个短暂确认窗口内没有新步骤时，回合才算结束。

如果 Antigravity 装在非常规位置，可用 `AGY_LANGUAGE_SERVER` 覆盖 Language Server
路径。

## 安装

这是一个 dsh **bundle 插件**，用 `dsh plugin … add` 安装。按你机器上 dsh 的安装方式
选一种。

### 从 npm 安装（推荐）

```bash
dsh plugin --profile <profile> add antigravity-executor
```

把 `<profile>` 换成你的 profile 名 —— 普通 `dsh web` 安装是 `web`，桌面端是
`tauri`。该命令会把 `add` 转发给 profile 目录里的 pnpm，并把包追加进
`dsh.profile.bundles`。

如果 `dsh` 不在 `PATH` 上，从 dsh 安装目录直接调启动器：

```bash
# 桌面端安装
node node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile tauri add antigravity-executor

# 或用 npx
npx -y @deepseek-ai/dsh plugin --profile web add antigravity-executor
```

### 从本地检出安装

改造插件本身时很有用 —— `link:` 依赖指向你的工作副本，改完不用重装即可生效：

```bash
git clone https://github.com/wuyu1327083461/antigravity-executor.git
dsh plugin --profile <profile> add "link:$(pwd)/antigravity-executor"
```

Windows PowerShell：

```powershell
git clone https://github.com/wuyu1327083461/antigravity-executor.git
dsh plugin --profile tauri add "link:F:/path/to/antigravity-executor"
```

### 验证并启用

```bash
# 组合后的配置里应能看到这一行
dsh --profile <profile> --dump-config   # 找 `id: antigravity-executor`
```

然后在 dsh Web UI 里启用它：**插件 → 已安装插件 → Antigravity Executor**。关掉它
会注销这些工具；两种情况下都不会拉起任何进程，因此没有东西需要 kill。该开关会把
`disabled: true|false` 写进 profile 的 `cordis.patch.yml` 里
`id: antigravity-executor` 这一行，并在开启 HMR 的 profile 上立即生效。

### 卸载

```bash
dsh plugin --profile <profile> remove antigravity-executor
```

这会移除依赖与 bundle 条目。插件不在自己目录之外保留任何状态（`sessions.json` 就在
那里，且已被 gitignore）。

## 环境要求

- **Antigravity 桌面端正在运行且已登录**（最小化即可 —— 但不能退出）。不涉及任何
  API Key。
- Node.js ≥ 22.19.0（与 dsh 自身的需求一致）

## 已知限制

**没有内核级的文件系统沙箱。** `agentapi` 创建的会话带有 `workspaces: []` 与
`enforcedWorkspaceValidation: false`，所以「只碰这个目录」是提示词级约束加一个
审计器，而不是隔离。插件会在每次派发的任务里注入前置说明（绝对路径、按平台的工作
目录前缀、shell 语法提示），然后核验实际发生了什么，并在配置允许时中途取消，但
铁了心的执行器依然不会被物理拦住。

`run_command` 在 Windows 上执行于 **PowerShell**，其他平台是 POSIX shell，其默认
工作目录是 Antigravity 安装目录而非你的项目 —— 这就是前置说明里 `Set-Location` /
`cd` 前缀是必需的而非装饰的原因。

基于以上原因，每次委派后务必自己复核 diff 并跑验证。工具会返回经审计的工具调用
轨迹与工作区结论来降低这件事的成本，而模型的自述应当被视为一种主张，而非结果。

**区域限制属于后端，不属于插件。** Antigravity 服务可能返回
`FAILED_PRECONDITION (code 400): User location is not supported for the API use.`
插件会原样透出这段文本并在几秒内失败，而不是把整个 `maxSeconds` 预算耗光，但它无法
绕过该限制。

**服务端已报结束、但磁盘日志尚未落盘的回合，会通过 RPC 读取。** 那是结算路径；最终
报告仍优先使用磁盘 transcript，因为它承载完整的历史回合。

## 开发

```bash
npm test                      # node --test lib/*.test.js
node --test lib/turn.test.js  # 单个模块
```

测试从不触碰 Antigravity：RPC 客户端、transcript 读取器与时钟均可注入，因此每条
结算路径（rpc-idle、静默窗口兜底、熔断、超时、执行器错误）都能确定性地被覆盖。
`CONTRACT.md` 记录了模块接口与本实现所依赖的实测 RPC 事实。

## 许可证

MIT。请一并阅读顶部的警告：许可证覆盖的是这份代码，而不是你对他人条款的遵守。
