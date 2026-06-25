# Guldstandard för nya blixten85-repon

Sammanställt 2026-06-25 från politiker-webapp + product-describer (de mest
fullständigt utrustade repona vid tidpunkten). Använd som checklista när ett
nytt repo skapas — kopiera filerna, ANPASSA det som är repospecifikt
(markerat nedan), kör inte blint.

## .github/workflows/

| Fil | Universell? | Anpassning som krävs |
|---|---|---|
| `claude.yml` | Ja, rakt av | — |
| `auto-merge.yml` | Ja, struktur | `claude:`-jobbets villkor (`claude/`-prefix + `claude`-etikett) är generiskt. `dependabot`/`security-autofix`/`codex`/`copilot`-jobben likaså. |
| `ci-autofix.yml` | Ja, rakt av | **Saknades i politiker-webapp — lägg till där också.** Triggar `@claude`-kommentar på PR:en när CI-workflowen "CI" misslyckas. Detta är den faktiska "auto-fixa-tills-grön"-mekanismen, INTE en CodeRabbit-inställning (sökte förgäves efter den där tidigare denna session). |
| `auto-rebase.yml` | Ja, rakt av | — |
| `auto-release.yml` | Ja, rakt av | Semantic versioning från conventional commits, taggar `vX.Y.Z`. |
| `auto-commit.yml` | Ja, rakt av | Bara en varning vid icke-conventional-commit, blockerar inte. |
| `auto-label.yml` | Ja, struktur | Kräver `.github/labeler.yml` (se nedan). |
| `security-alerts-sync.yml` | Ja, rakt av | Kräver `secrets.GH_TOKEN` (fine-grained PAT, inte default `GITHUB_TOKEN` — den saknar scope för code-scanning/dependabot-alerts). |
| `dependency-review.yml` | Ja, rakt av | Blockerar PR:er som introducerar high-severity-sårbara beroenden. |
| `ci.yml` | **Nej — skriv om per repo** | TypeScript/Workers-repon: matrix av `worker: [app, sender]`-typ (politiker-webapp-mönstret). Python+Docker-repon: se product-describer-mönstret (pytest + GHCR-bygge) istället. Välj rätt mall, inte bägge. |
| `cleanup-packages.yml` | **Bara om repot publicerar en Docker-image till GHCR** | Skippa helt för rena Workers-repon (ingen image att rensa). |
| `feedback-triage.yml` | **Bara om repot har en feedback-funktion** | App-specifik (politiker-webapp har en feedback-knapp i UI:t) — kopiera bara om motsvarande funktion finns. |

## .github/ (övrigt)

- **`labeler.yml`** — universell STRUKTUR, men `changed-files`-mönstren måste matcha repots faktiska katalognamn (t.ex. `app/**`/`processor/**`/`sync/**` för en 3-Workers-uppdelning, inte `app/**`/`sender/**`).
- **`pull_request_template.md`** — universell, rakt av.
- **`ISSUE_TEMPLATE/`** — universell, rakt av (bug_report + feature_request, både .md och .yml-varianter, plus `config.yml`).
- **`FUNDING.yml`** — **REPOSPECIFIKT, kopiera ALDRIG rakt av.** politiker-webapp har en PayPal-länk kopplad till just den publika tjänsten. product-describer har bara `github: [blixten85]` (inget donationsflöde). Avgör per repo om en custom-länk är relevant.
- **`renovate.json`** ELLER **`dependabot.yml`** — **inte båda** (gav dubbla dependency-PR:er i politiker-webapp, oavsiktlig redundans, inte ett medvetet val). Renovate rekommenderas (mer konfigurerbart, redan satt upp med auto-merge av patch/dev-deps). Om Renovate: behåll `github-actions`-ekosystemet som en EGEN `package-ecosystem`-rad om dependabot.yml används istället.
- **CODEOWNERS** — fanns INTE i politiker-webapp vid genomgången. Inte etablerad del av standarden ännu.

## Repo-inställningar (via `gh api`/`gh repo edit`, inte filer)

- **Branch protection (ruleset, inte legacy branch protection)** på `main`:
  - `deletion`, `non_fast_forward` (skydd mot force-push/borttagning)
  - `pull_request`: `required_approving_review_count: 0` (inget krav på mänsklig review — CI + CodeRabbit räcker), `dismiss_stale_reviews_on_push: true`
  - `required_status_checks`: lista ALLA faktiska check-namn som körs (typecheck-jobben för varje worker, CodeQL:s `Analyze (...)`-rader per språk som faktiskt finns i repot, `CodeRabbit`) — **måste matcha exakt vad CI:t faktiskt heter i DETTA repo**, kopiera inte namnen rakt av.
- **CodeQL default setup** (API: `PUT /repos/{owner}/{repo}/code-scanning/default-setup`) — `languages` ska bara innehålla språk som FAKTISKT finns i repot (`actions` + `javascript-typescript` för ett rent TS-repo, lägg till `python` bara om Python-kod finns).
- **Labels**: standarduppsättningen (bug/documentation/duplicate/enhancement/good first issue/help wanted/invalid/question/wontfix — GitHubs defaults, rör inte) + `dependencies`, `github_actions` (eller motsvarande Renovate-grupperingsnamn), `ci`, `infra`, `claude` (`#6f42c1`, "PR created/fixed by Claude Code — eligible for auto-merge once CI is green"), samt en etikett per Worker/katalog (`app`, `sender`/`processor`/`sync` osv, matchar `labeler.yml`).
- **Repo-flaggor**: `delete_branch_on_merge: true`, alla tre merge-metoder tillåtna (`squash`/`merge`/`rebase`), `squash_merge_commit_title: COMMIT_OR_PR_TITLE`.

## Känt hål i denna standard (ej åtgärdat ännu)

- `ci-autofix.yml` saknades i politiker-webapp/politiker-kontakter — borde läggas till där också, inte bara nya repon, för att få samma "auto-fixa-tills-grön"-beteende överallt.
- Ingen CODEOWNERS-fil någonstans än.
