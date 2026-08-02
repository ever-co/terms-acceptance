# Changelog

All notable changes to this package are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-08-02

First release. Not yet published to npm.

### Added

- **Core** — `TermsAcceptanceService`, the `AcceptanceRecord` model
  (`documentId`, `version`, `sha256`, `acceptedAt`, `locale`, `ipHash`, `userAgent`, `method`),
  and the four-method `AcceptanceStorageAdapter` interface.
- **Corpus integration** — `selectRequiredDocuments`, `findDocument` and `assertPublishedText`
  read a legal corpus `dist/index.json`, so an acceptance is pinned to a digest that was
  actually published.
- **Materiality** — declared per version in the corpus `history`; policies
  `declared-or-semver` (default), `declared` (throws rather than guess) and `semver`.
  MAJOR blocks, minor and patch are notices.
- **Immutability** — deep-frozen records, a `fingerprint` integrity digest verified on read,
  no `update`/`delete` in the adapter interface, a Postgres `BEFORE UPDATE OR DELETE` trigger,
  and Firestore rules that deny mutation.
- **Adapters** — `memory`, `sql` (any `query(sql, params)` executor), `typeorm`
  (EntitySchema + migration, no TypeORM import), `better-auth` (plugin + model),
  `clerk` (verified webhook into our own table), `firebase` (Firestore + security rules).
- **React** — `TermsCheckbox` (hands back the payload it gates on), `ReacceptModal`
  (non-dismissible while blocking), `useTermsGate`. React is an optional peer, `^18.2 || ^19`.
- **Privacy** — `hashIp` requires a per-deployment salt of ≥16 characters; `buildRecord`
  rejects a raw IP in `ipHash`.
- Dual ESM + CJS builds, full TypeScript types, 72 tests, CI on self-hosted runners.
