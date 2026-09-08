# Sensitive Information

- `effect-utils` is a public repository but used in the context of private repositories. It's very important to never commit sensitive information to this repository including information from/about private repositories.

# Development Commands

Use `devenv tasks run <task>` (devenv tasks) to execute tasks with dependencies:

- **TypeScript**: `devenv tasks run ts:check` or `devenv tasks run ts:build-watch` (watch mode) or `devenv tasks run ts:clean`
- **Linting**: `devenv tasks run lint:check` or `devenv tasks run lint:fix`
- **Testing**: `devenv tasks run test:run` (all) or `devenv tasks run test:<pkg>` (single package) or `devenv tasks run test:watch`
- **Build**: `devenv tasks run ts:build`
- **Install**: `devenv tasks run pnpm:install`
- **Genie**: `devenv tasks run genie:run` or `devenv tasks run genie:watch` or `devenv tasks run genie:check`
- **Check all**: `devenv tasks run check:quick` (ts + lint) or `devenv tasks run check:all` (ts + lint + test)

Use the `--no-tui` flag to see all output. If tools aren't directly in `$PATH`, enter the dev environment first with `devenv shell`.

We're using megarepo for repo management. We're using `pnpm` temporarily for installs (bun is still used to run scripts) and `devenv` to manage the development environment.

# Genie (Config File Generation)

Config files like `package.json`, `tsconfig.base.json`, and `.github/workflows/ci.yml` are generated from TypeScript source files using genie. The source files have a `.genie.ts` suffix (e.g., `package.json.genie.ts`).

- **Never edit generated files directly** - they are read-only and will be overwritten
- **Edit the `.genie.ts` source file** and run `devenv tasks run genie:run` to regenerate
- Shared constants (catalog versions, tsconfig options) live in `genie/repo.ts`
- `devenv tasks run check:quick` verifies generated files are up to date via `devenv tasks run genie:check`

# Changelog

Keep `CHANGELOG.md` updated:

- Add entries under `[Unreleased]` when making changes
- When cutting a release, move `[Unreleased]` entries to a new version section with the release date

# Task Management

Use GitHub issues or an issue checklist for non-trivial work.

- Link the issue in the PR when the repo workflow expects it
- File follow-up GitHub issues for out-of-scope work discovered during implementation

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**

- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
