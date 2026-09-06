# Rime agent harness review

What the harness looks like from inside a turn, written from Rime's own review of this repository
(2026-09-06, thread `we2j6sk` on the desktop). The turn that produced it never finished: the relayed
model request dropped three times in a row and the research was compacted before it could be written
up. This file is that write-up, reconstructed from the compaction brief and the surviving items, plus
what was changed as a result.

Verified observations are marked **seen**. Everything else is a suggestion.

## F1 — Reads had no way to ask for less (seen, fixed)

Every tool result is capped at 12,000 chars (`OUTPUT_CAP`, `core.ts`) and an over-cap result is
replaced by an error, never sliced. That is the right contract: the model never sees torn JSON. But
`project_read` had no pagination, so in one review turn:

| Read | Chars | Result |
|---|---|---|
| `project_read git` | 63,358 | refused |
| `project_read file AGENTS.md` | 40,690 | refused |
| `project_read file README.md` | 16,210 | refused |

The workaround was `js-exec -c` inside the sandbox calling `tools.project_read`, writing the full
text to `/work`, then `sed`/`rg` in bounded slices. It works and it is absurd.

Changed: `project_read file` returns a page (`from`, `lines`, default as many lines as fit under
9k serialized; the result names `next` and, for long lines, `nextColumn`). Conflicting disk text is
read separately with `version: "disk"`. `project_read git` accepts `path` to scope the diff and
bounds its serialized tool result at 9k with `truncated: true`; the Changes ward retains full diffs. The pattern already existed for attachments
(`read_document` / `search_document`); files and git now follow it.

## F2 — The sandbox's own cap contradicted the outer one (seen, fixed)

`runShell` allowed 40,000 chars of stdout while the tool result cap is 12,000, and JSON escaping
inflates text 5–20%: `head -c 10100` came back as 12,291 serialized chars and was refused. So every
command between ~9k and 40k of output produced zero usable chars.

Changed: shell output is cut by serialized size to fit under the cap (`fitOutput`, `shell.ts`),
`truncated` says when.

## F3 — The file tool could edit but not create (seen, fixed)

`project_edit` required an existing buffer, `createFile` existed in `projects.ts` but was not
exposed. Writing this document meant starting a Codex terminal session whose only task was
`touch docs/rime-agent-harness-review.md`, then reviewing its output, then marking the task done.

Changed: `project_edit` with `revision: 0` on a path that does not exist creates the file, then
edits it. Every other path still needs the revision `project_read` returned.

## F4 — The memory scope in the prompt was wrong (seen, fixed)

The notes block said `/work/AGENTS.md` is "the only thing that survives across wards, conversations
and restarts". Memory documents (`remember`/`forget`) and skills (`save_skill`) survive the same
way, and their indexes ride in every turn. An agent that believes the prompt puts everything in the
8k notes file and prunes what should have been a memory document.

Changed: the block now names all three stores and which facts go where.

## F5 — A failed turn vanished (seen, fixed)

When a turn throws, the items (tool calls and outputs) are flushed, but no assistant message is
recorded. So on reload the transcript shows the user's message and nothing after it. `/history`
never sees the turn. And the next turn's compaction folds those items into a brief that says
"the verbatim transcript is on disk at /history/<id>.md" — a file that does not contain the turn.
That is exactly what happened here: 138 items of research became one brief, and the file it pointed
at had five entries.

Changed: `bankFailure` (`core.ts`) records what the turn said and did, plus the error, as the
assistant's message on all three turn paths (chat, confirm resume, headless). The transcript, the
disk mirror and the next compaction see the same record a successful turn would leave.

## F7 — Compaction fired several times per task (seen, fixed)

One threshold (150k chars, ~37k tokens) served every provider. Every codex model takes 272k+ input
tokens and the fixed part of a turn (instructions, tool schemas) is ~60k on its own, so a codex
thread was folded after roughly a third of the room it had, each fold a model round-trip and a
lossy brief. The budget is per provider now: codex folds at 400k chars and cuts at 480k, OpenRouter
keeps 150k/200k for its 128k-context models.

## F6 — The relay dropped long model rounds (seen, fixed)

The desktop relays each model call to the server's `/api/devices/harness/model` and waits for one
JSON body. The server does not answer until the provider does. frostdev.io sits behind Cloudflare,
which returns 524 when the origin is silent for 100 seconds; a reasoning round over a ~100k-token
context is silent for longer. The server finishes the call later and logs `ok`, the desktop already
shows "The Rime server disconnected during the model request", and nothing on the server records a
failure (the harness location logs nothing by design). The server's own codex timeout was 120s, so
even without Cloudflare a two-minute think failed.

Changed: the `/model` route streams a whitespace heartbeat every 15s until the provider answers,
then the JSON (an error rides the body too, with its status). The desktop parses the body and
throws the server's error with its status. Timeouts now nest: codex 300s < desktop 330s < nginx 360s.
The desktop and server must be on the same version for this; an older desktop against a newer server
would read an error body as a result.

## Suggestions not implemented

- **S1 Durable task evidence.** Marking a terminal task `done` takes a `review` string. Nothing
  ties it to what was checked (which buffer revision, which git status). A receipt — the revision
  and status hash the reviewer saw — would make "done" verifiable later.
- **S2 Search results have the same shape problem.** `searchFiles` caps at 200 matches × 300 chars,
  which is 60k. It did not overflow in this review; it will.
- **S3 Progress the user can see** (done). The ward now carries a context indicator: the thread's
  size against its compaction threshold, filled as a pill, with the last round's billed tokens and
  cache rate in its tooltip. It repaints from a `usage` event after every model round.
- **S4 Desktop runtime stderr is discarded** (`desktop/src/runtime.rs`: `Stdio::null()`). The
  relay failure above left no trace on the desktop either. Not the agent's finding, but the reason
  this incident had to be reconstructed from the database.

## What already works and should stay

- Revision-checked buffer edits with lease ownership; a human buffer is never taken over.
- New terminal sessions start in Human mode; the agent cannot type into them without delegation.
- Tool batches run concurrently, at most one confirm parks per batch, and outputs are banked every
  round so a restart mid-turn keeps the work.
- The outer output cap. The fix for F1/F2 is paging and honest cuts, not a bigger cap.
