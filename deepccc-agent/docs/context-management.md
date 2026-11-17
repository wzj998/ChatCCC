# Context retention and recovery

DeepCCC keeps a persisted conversation separately from the messages replayed to
the model. Version 0.2.34 improves the latter without rewriting executed tool
arguments, saved files or the persisted tool history.

## Project instructions

The four workspace instruction files (`AGENTS.md`, `AGENTS.local.md`,
`CLAUDE.md`, `CLAUDE.local.md`) share a 32 KiB UTF-8 budget. Small files retain
their order and contents. Oversized files include bounded beginning/end excerpts
and an explicit notice identifying the omitted middle. Small local overrides
receive space before large files. The agent must search or read omitted relevant
instructions before editing; an excerpt never proves the entire file was read.

## Tool replay within a turn

The default tool-result budget is 96,000 serialized characters, with a 24,000
character per-result cap. The latest `read_file` result for each skill's
`SKILL.md` or `references/*.md` receives priority over ordinary old results,
within a shared instruction allocation of at most 32,000 characters and half of
the result budget. Older reads of the same path are marked superseded. A failed
new read does not silently revive obsolete instructions. Retained instruction
text remains tool evidence; its instruction authority is unchanged.

Large failed process results retain a bounded status summary: exit code,
timeout/signal, task identifiers and available stderr/error. An omitted stdout
body is explicitly unavailable, so a successful exit alone never proves that
evidence was inspected. Newer evidence is retained next, followed by other old
results where space permits. Serialized escaping counts toward the budget.

When historical tool arguments exceed 64,000 characters, long string values
such as scripts are shortened in the replay clone. Keys, types and short values
remain intact. This is a best-effort payload reduction, not a hard total limit
for arbitrary large arrays or object keys. Executed calls are not changed. Read
the saved script before reusing a shortened argument.

Raw stream diagnostics record `deepccc_intra_turn_tool_context_compacted`,
including both input/output size counts and retained instruction/status counts.
This is distinct from conversation-summary compaction. Enable raw stream logs
to diagnose it; no new public stream-JSON event is required.

## Upstream comparison and limits

The design was checked against primary sources, rather than assuming that a
large advertised context window preserves all useful instructions:

- [Codex defaults](https://github.com/openai/codex/blob/main/codex-rs/config/defaults.toml)
  include a 32,768-byte project document limit. DeepCCC adopts that budget size;
  its allocation and explicit head/tail excerpt policy are implemented here.
- [OpenCode compaction](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/compaction.ts)
  reserves input/output room and carries a structured continuation checkpoint.
  Its current source does not establish a universal skill-pinning rule.
- [Pi compaction](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts)
  tracks file operations, preserves recent context and reserves output space.
  These are useful next-stage references for durable cross-turn recovery.

These changes do not replace model-specific token budgeting, durable task
checkpoints, or domain validation. Skill retention is limited by the replay
budget and available history; a whole-conversation summary can still remove
earlier reads. After a checkpoint/resume or summary, reload the active skill and
validate the saved task state before continuing. Framework fixes cannot certify
that the model read every relevant source or made a correct domain decision.
