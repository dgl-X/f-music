# Repository Guidelines

## Project Structure & Module Organization

The Node.js 24 server lives in `src/`; `src/server.js` wires together focused services such as authentication, catalog, uploads, federation, and observability. Browser assets are plain HTML, CSS, and JavaScript under `public/`. Tests are in `test/` and generally mirror service names. Operational tooling belongs in `scripts/`, Debian packaging in `packaging/`, and monitoring/deployment examples in `deploy/`. Federation schemas, compatibility fixtures, and signature vectors are under `federation/`. The Android client is maintained in `android/`, with Java sources in `android/app/src/main` and unit tests in `android/app/src/test`.

Do not commit generated content from `builds/`, `dist/`, `android/build/`, `android/builds/`, media storage, or dependency caches.

## Build, Test, and Development Commands

- `npm ci` installs the locked server dependencies.
- `npm start` runs the API and web application.
- `npm run worker` starts the background media worker.
- `npm test` runs all Node tests sequentially; keep this mode because several tests use shared process resources.
- `npm run test:media:integration` exercises upload, Range, and media processing.
- `npm run test:federation:two-node` verifies the two-node federation flow.
- `./packaging/build-deb.sh` builds the Debian package.
- `cd android && ./gradlew --no-daemon testDebugUnitTest assembleDebug` tests and builds Android.

Server development requires PostgreSQL and FFmpeg/ffprobe. Android requires JDK 17 and Android SDK 36.

## Coding Style & Naming Conventions

Use ES modules, semicolons, single quotes, two-space indentation, `camelCase` for functions and variables, and `PascalCase` for classes. Keep HTTP routing thin and place database or provider behavior in focused `*-service.js`, `*-http.js`, or `*-provider.js` modules. Java follows four-space indentation and standard Android naming. No automatic formatter is enforced; run `git diff --check` before committing.

## Testing Guidelines

Use `node:test` with strict assertions. Name server tests `test/<module>.test.js` and describe externally observable behavior. Bug fixes need a regression test; API and federation changes must remain backward-compatible. Run `npm test` plus the relevant integration command before opening a PR.

## Commit & Pull Request Guidelines

Recent commits use concise Russian imperative subjects, for example `Исправить управление очередью Android`. Keep each commit and PR focused. PRs should explain behavior, verification commands, compatibility or migration impact, and link the issue. Include screenshots for visible WEB or Android changes.

## Security & Configuration

Never commit tokens, passwords, cookies, signing keys, private addresses, production logs, `.env`, or real media. Run `node scripts/check-repository-secrets.mjs` and follow `SECURITY.md` for private disclosure.
