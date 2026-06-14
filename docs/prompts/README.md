# Copy-paste prompts — one file per tool

- **trae-deepseek.md** — paste into Trae (DeepSeek V4 Pro)
- **codex-gpt55.md** — paste into Codex (GPT-5.5)
- **claude-code-opus.md** — paste into Claude Code (Opus 4.8 / Fable 5)

Each prompt is complete on its own. Run in this exact order:

| # | Prompt | Tool | Phase |
|---|--------|------|-------|
| 1 | WP-0 Docs activation | Trae | 0 |
| — | YOU: commit all, `git tag checkpoint-phase0` | — | 0 |
| 2 | WP-1 Tenancy migration | Claude Code | 1 |
| 3 | WP-2 Transactional audit | Trae | 1 |
| 4 | WP-3 Gezi rename | Trae | 1 |
| 5 | PHASE REVIEW (set phase=1) | Claude Code | 1 gate |
| 6 | WP-4 Draft transactions | Codex | 2 |
| 7 | WP-5 Multi-item NLP | Codex | 2 |
| 8 | WP-6 Item matcher | Trae | 2 |
| 9 | WP-7 Currency shorthand | Trae | 2 |
| 10 | WP-8 Confidence + confirm-with-default | Codex | 2 |
| 11 | WP-9 NLP corpus | Trae | 2 |
| 12 | PHASE REVIEW (set phase=2) | Claude Code | 2 gate |
| 13 | WP-10 Flutterwave core | Claude Code | 3 |
| 14 | WP-11 Reconciliation + dunning | Trae | 3 |
| — | YOU: Flutterwave sandbox checklist (BUILD-PLAYBOOK §C3) | — | 3 gate |
| 15 | WP-12 tenant_users + switch | Trae | 4 |
| 16 | WP-13 360dialog migration | Codex | 4 |
| 17 | WP-14 Broadcast gating | Trae | 4 |
| — | YOU: 360dialog checklist (BUILD-PLAYBOOK §C4) | — | 4 gate |
| 18 | WP-15 Backups | Trae | 5 |
| 19 | WP-16 branch_id + ledger note | Trae | 5 |
| 20 | WP-17 SECURITY REVIEW | Claude Code | 5 gate |
| — | YOU: production cutover (BUILD-PLAYBOOK WP-18) | — | 5 |
| 21+ | WP-19..22 web app | Codex | 6 |
| 25 | WP-23 POS offline-first | Claude Code | 6 |

Rules of thumb:
- One prompt per session. New session per prompt.
- After EVERY session, run the verification block (bottom of each file) yourself.
- Stuck? DeepSeek fails twice → rerun same prompt in Codex. Codex fails → DEBUG
  prompt in Claude Code. Never let a model improvise around a blocker.
- Commit after every green WP: `git commit -m "WP-x: <subject>"`.
