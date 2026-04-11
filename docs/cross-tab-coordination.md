# Cross-Tab Coordination

SoulForge supports up to 5 concurrent tabs editing the same codebase. The WorkspaceCoordinator manages advisory file claims so tabs are aware of what others are editing.

## How It Works

When any tab edits a file (via `edit_file`, `multi_edit`, `rename_symbol`, `move_symbol`, `rename_file`, `refactor`, or shell writes), the file is automatically claimed for that tab. Other tabs see the claim and get advisory warnings.

### Claim Lifecycle

| Event | What happens |
|-------|-------------|
| Agent edits a file | File claimed for the tab via `checkAndClaim` |
| Another tab edits the same file | Warning returned: "File X is being edited by Tab Y" |
| Tab goes idle (prompt finishes) | Claims released after 5 seconds |
| User aborts (Ctrl+X) | Claims released immediately |
| Tab closes | Claims released + tab marked as closed (blocks ghost claims) |
| Stale sweep (every 30s) | Claims older than 5 minutes released regardless |
| Leaked agents (15 min) | Agent counters cleared by sweep |

### Git Blocking

Git operations that modify the working tree (`commit`, `stash`, `restore`, `branch switch`) are blocked while another tab has active dispatch agents. This prevents partial commits during concurrent edits.

The block is per-tab — a tab's own agents don't block its own git operations. When blocked, the tool returns a terminal error ("BLOCKED ... do not attempt again") instead of a retryable error, preventing token-burning retry loops.

### Contention Handling

When `edit_file` fails with `old_string not found` AND the file is claimed by another tab, a terminal CONTENTION error is returned instead of the normal rich error. The agent stops and informs the user instead of retrying.

## Commands

| Command | Description |
|---------|-------------|
| `/claim` | Show all active file claims across tabs |
| `/claim release <path>` | Release a specific file claim from current tab |
| `/claim release-all` | Release all claims from current tab |
| `/claim force <path>` | Steal a file claim from another tab |

## How claims work

Every file-modifying tool automatically claims the file for the active tab. The claim lifecycle, git blocking, and contention handling are described above.

## Design Decisions

**Advisory, not blocking.** Edits always proceed. The warning tells the agent another tab owns the file — the agent can choose to skip or proceed. This avoids deadlocks.

**Git is the exception.** Git operations during active dispatch are hard-blocked because committing mid-dispatch produces garbage (partial edits). This is the only hard gate.

**Claims are transient.** Auto-released on idle, on abort, on tab close. Nothing persists forever.
