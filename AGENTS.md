# Repository Guidelines

## Project Structure & Module Organization

The Node.js 24 server lives in `src/`; `src/server.js` wires together authentication, catalog, uploads, federation, and observability. Browser assets are under `public/`, tests under `test/`, operational tooling under `scripts/`, Debian packaging under `packaging/`, and deployment examples under `deploy/`. Federation schemas and fixtures are under `federation/`. Android is maintained separately in the `dgl-X/f-music-android` repository.

Do not commit generated content from `builds/`, `dist/`, `android/build/`, `android/builds/`, media storage, or dependency caches.

## Build, Test, and Development Commands

- `npm ci` installs the locked server dependencies.
- `npm start` runs the API and web application.
- `npm run worker` starts the background media worker.
- `npm test` runs all Node tests sequentially; keep this mode because several tests use shared process resources.
- `npm run test:media:integration` exercises upload, Range, and media processing.
- `npm run test:federation:two-node` verifies the two-node federation flow.
- `./packaging/build-deb.sh` builds the Debian package.
- `npm run test:worker:integration` checks queue coordination using a dedicated PostgreSQL database.

Server development requires PostgreSQL and FFmpeg/ffprobe.

## Coding Style & Naming Conventions

Use ES modules, semicolons, single quotes, two-space indentation, `camelCase` for functions and variables, and `PascalCase` for classes. Keep HTTP routing thin and place database or provider behavior in focused `*-service.js`, `*-http.js`, or `*-provider.js` modules. Java follows four-space indentation and standard Android naming. No automatic formatter is enforced; run `git diff --check` before committing.

## Testing Guidelines

Use `node:test` with strict assertions. Name server tests `test/<module>.test.js` and describe externally observable behavior. Bug fixes need a regression test; API and federation changes must remain backward-compatible. Run `npm test` plus the relevant integration command before opening a PR.

## Commit & Pull Request Guidelines

Recent commits use concise Russian imperative subjects, for example `Исправить управление очередью Android`. Keep each commit and PR focused. PRs should explain behavior, verification commands, compatibility or migration impact, and link the issue. Include screenshots for visible WEB or Android changes.

## Security & Configuration

Never commit tokens, passwords, cookies, signing keys, private addresses, production logs, `.env`, or real media. Run `node scripts/check-repository-secrets.mjs` and follow `SECURITY.md` for private disclosure.
