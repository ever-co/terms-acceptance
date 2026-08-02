# terms-acceptance

**Versioned, provable terms-of-service acceptance records.**

A storage-agnostic core, adapters for the four auth patterns you actually meet in the wild
(own JWT + TypeORM, Better Auth, Clerk, Firebase Auth), and an optional React checkbox and
re-accept modal.

[![npm](https://img.shields.io/npm/v/terms-acceptance.svg)](https://www.npmjs.com/package/terms-acceptance)
[![licence](https://img.shields.io/npm/l/terms-acceptance.svg)](./LICENSE)

---

## Why this exists

A checkbox is not consent. It is a *claim* that consent happened.

The pattern this package was written against is depressingly common, and was found in three
separate products in one audit: a signup form renders `I agree to the Terms`, uses the checkbox
to enable the submit button, and then builds a request payload that never mentions it. The user
saw a checkbox. The database has nothing. If someone later asks *which version of the terms did
this customer accept, and what did they say at the time?* — there is no answer, and no way to
construct one.

`terms-acceptance` makes the answer a row:

```jsonc
{
  "id": "ta_m8k2p10000a1b2c3d4e5f6",
  "subjectId": "user_7f3a…",
  "documentId": "tos:gauzy",
  "version": "2.0.0",
  "sha256": "9f2c…",              // the exact text, reproducible from the corpus
  "acceptedAt": "2026-08-02T09:14:03.221Z",
  "locale": "en",
  "ipHash": "b41e…",              // salted; never the address
  "userAgent": "Mozilla/5.0 …",
  "method": "reaccept-modal",     // *how* consent was obtained
  "fingerprint": "3d7a…"          // integrity digest over everything above
}
```

Two fields carry most of the weight.

**`sha256`** pins the acceptance to the exact wording. A legal corpus build (`@ever-co/legal`
and its siblings) already emits a `sha256` per document into `dist/index.json`. Store that
digest, and years later you can check out the corpus at that tag, re-run the build, and prove
the text this person agreed to — byte for byte. A record that says "accepted ToS v2" and nothing
more is an assertion; a record that carries the digest is evidence.

**`method`** distinguishes `signup-checkbox` from `reaccept-modal`. Proving *how* consent was
obtained matters as much as proving that it was: a tick during account creation and a blocking
modal shown to an existing user are legally different events, and "we can't tell which happened"
is not a good position to be in.

---

## Install

```bash
npm install terms-acceptance
```

Zero runtime dependencies. React is an optional peer (`^18.2 || ^19`) and is only needed if you
import `terms-acceptance/react`.

| Entry point                    | What it gives you                                        |
| ------------------------------ | -------------------------------------------------------- |
| `terms-acceptance`             | service, evaluation, corpus reading, hashing, memory adapter |
| `terms-acceptance/sql`         | any SQL database via a `query(sql, params)` executor      |
| `terms-acceptance/typeorm`     | entity schema + migration (NestJS, own JWT)               |
| `terms-acceptance/better-auth` | Better Auth plugin + model                                |
| `terms-acceptance/clerk`       | webhook handler writing into *your* table                 |
| `terms-acceptance/firebase`    | Firestore adapter + security rules                        |
| `terms-acceptance/react`       | `TermsCheckbox`, `ReacceptModal`, `useTermsGate`          |

---

## The 60-second version

```ts
import { TermsAcceptanceService, selectRequiredDocuments } from 'terms-acceptance';
import { SqlAcceptanceAdapter } from 'terms-acceptance/sql';
import corpus from '@ever-co/legal/index.json' with { type: 'json' };
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const terms = new TermsAcceptanceService({
  adapter: new SqlAcceptanceAdapter({ executor: pool }),
  corpus,                                   // refuses to record unpublished text
  ipSalt: process.env.TERMS_IP_SALT,        // per-deployment secret
});

await terms.init();                         // creates the table + append-only trigger

// What this product currently requires, straight from the corpus:
const required = selectRequiredDocuments(corpus, {
  product: 'gauzy',
  locale: 'en',
  url: (doc) => `https://app.gauzy.co/${doc.document}`,
});

// At signup:
await terms.recordMany(required, {
  subjectId: user.id,
  method: 'signup-checkbox',
  ipHash: terms.hashIp(req.ip),
  userAgent: req.headers['user-agent'],
});

// At every login:
const status = await terms.status(user.id, required);
if (!status.satisfied) {
  // status.blocking → show the re-accept modal, do not let the session continue
}
```

---

## Re-acceptance: what counts as material

A **MAJOR** version bump is material and triggers a blocking modal at next login.
**Minor and patch** are notice-only — a banner, not a wall.

Crucially, **materiality is declared per version in the corpus, never decided ad hoc at
runtime.** Whether adding an arbitration clause is material is a legal judgement made by the
person who published the text; it is not something a `switch` statement should be inferring from
a version number at 3am. The corpus index carries it:

```jsonc
{
  "document": "tos",
  "product": "gauzy",
  "version": "2.0.0",
  "sha256": "9f2c…",
  "history": [
    { "version": "1.0.0", "material": true,  "sha256": "1a2b…" },
    { "version": "1.1.0", "material": false, "sha256": "…", "summary": "Typo fixes." },
    { "version": "2.0.0", "material": true,  "sha256": "9f2c…", "summary": "Added an arbitration clause." }
  ]
}
```

Given a user on `1.0.0`, `evaluateAcceptance` walks the declared entries newer than what they
accepted and blocks if any is `material: true`. The `summary` strings are handed to the modal so
the user is told what changed.

Three policies:

| `materiality`                  | Behaviour                                                                  |
| ------------------------------ | -------------------------------------------------------------------------- |
| `'declared-or-semver'` (default) | use `history` when declared; otherwise fall back to "MAJOR is material"    |
| `'declared'`                   | **throw** if the corpus declares nothing — materiality can never be guessed |
| `'semver'`                     | ignore `history`; MAJOR is material                                        |

Once your corpus declares `history` for every document, switch to `'declared'` in production and
the fallback can never fire silently.

```ts
const status = await terms.status(user.id, required, { materiality: 'declared' });

status.satisfied  // false
status.blocking   // [{ documentId: 'tos:gauzy', reason: 'material-change',
                  //    acceptedVersion: '1.0.0', requiredVersion: '2.0.0',
                  //    changes: [{ version: '2.0.0', summary: 'Added an arbitration clause.' }] }]
status.notices    // non-blocking changes → banner
status.current    // documents already accepted at the current version
```

`evaluateAcceptance(required, accepted, options)` is pure and synchronous — no storage, no
clock, no network — so it is safe in middleware, in a login hook, or in a test.

### The other two reasons

- `never-accepted` — blocking. No record at all.
- `text-mismatch` — blocking by default. The accepted version matches, but the digest does not:
  the text changed without a version bump. Treated as "this person never saw this text", which is
  the reading you want to be able to defend. Set `onTextMismatch: 'notice' | 'ignore'` if your
  corpus legitimately reflows whitespace.

A user who accepted something *newer* than what you are asking for is never re-prompted.

---

## Immutability

An acceptance record is evidence, and evidence that can be edited in place is not evidence. The
guarantee is enforced at four levels, deliberately:

1. **In the object.** `buildRecord()` deep-freezes; assignment throws in strict mode.
2. **In the adapter.** There is no `update` and no `delete` on the `AcceptanceStorageAdapter`
   interface. The shipped adapters define them only to throw `ImmutableRecordError`.
3. **In the database.** The Postgres DDL installs a `BEFORE UPDATE OR DELETE` trigger that raises.
   The Firestore rules deny `update` and `delete` outright. Application-level immutability is a
   convention; a trigger is a rule.
4. **In the record itself.** `fingerprint` is a sha256 over every other field. `assertIntact()`
   recomputes it, and the service verifies on every read — so a row rewritten by someone with
   database access fails loudly instead of lying quietly.

Corrections are made by recording a *new* acceptance, never by editing an old one. That is also
why writes are idempotent: re-recording the same `(subject, tenant, document, version)` returns
the existing record rather than writing a second one, so a double-clicked button cannot produce
two pieces of evidence that disagree about the time.

---

## Adapters

### Own JWT / NestJS + TypeORM — Ever Gauzy, Ever Traduora

The entity is an `EntitySchema` options object and the migration is a structurally-compatible
class, so **nothing imports `typeorm`** — installing this package never drags TypeORM into a
project that does not have it, and 0.2/0.3 both work.

```ts
// terms-acceptance.entity.ts
import { EntitySchema } from 'typeorm';
import { termsAcceptanceEntitySchema } from 'terms-acceptance/typeorm';

export const TermsAcceptance = new EntitySchema(termsAcceptanceEntitySchema);

// data-source.ts
import { CreateTermsAcceptance1754000000000 } from 'terms-acceptance/typeorm';

export default new DataSource({
  entities: [TermsAcceptance /* … */],
  migrations: [CreateTermsAcceptance1754000000000 /* … */],
});
```

```ts
// terms.service.ts (NestJS)
@Injectable()
export class TermsService {
  private readonly terms: TermsAcceptanceService;

  constructor(@InjectRepository(TermsAcceptance) repo: Repository<TermsAcceptanceEntity>) {
    this.terms = new TermsAcceptanceService({
      adapter: new TypeOrmAcceptanceAdapter({ repository: repo, In }),
      corpus,
      ipSalt: process.env.TERMS_IP_SALT,
    });
  }

  async onLogin(userId: string, tenantId: string | null) {
    return this.terms.status(userId, required, { tenantId });
  }
}
```

The raw SQL is exported too (`migrationSql.up` / `.down`), for Knex, Flyway or `psql`.

> The migration's `down()` drops the table — standard for a migration, but note what that means
> here: it destroys the evidence. In production, prefer to leave the table and stop writing.

### Better Auth — Ever Works, Ever Hust, GitHands

A plugin. `better-auth generate` / `migrate` creates the `termsAcceptance` model alongside `user`
and `session`, and writes go through Better Auth's own database layer, inheriting whatever driver
and pooling the app already configured.

```ts
import { betterAuth } from 'better-auth';
import { createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import { termsAcceptancePlugin } from 'terms-acceptance/better-auth';

export const auth = betterAuth({
  plugins: [
    termsAcceptancePlugin({
      required: () => selectRequiredDocuments(corpus, { product: 'ever-works' }),
      createAuthEndpoint,     // injected, so this package never imports better-auth
      sessionMiddleware,
      ipSalt: process.env.TERMS_IP_SALT,
      evaluate: { materiality: 'declared' },
    }),
  ],
});
```

Adds `GET /terms-acceptance/status` and `POST /terms-acceptance/accept`. Omit
`createAuthEndpoint` to get the schema and adapter only and wire your own routes.

Note the `userId` reference has **no** `onDelete: 'cascade'`: deleting a user should not silently
destroy the proof that they once agreed to something. If a jurisdiction requires erasure, do it
deliberately.

### Clerk — Cloc

Clerk's metadata is not an audit log: last-write-wins, editable from the dashboard, editable from
the browser in the case of `unsafeMetadata`, unversioned, and not queryable the way an auditor
needs ("show me everyone still on ToS 1.x"). So metadata is used only as *transport*, and the
evidence lands in a table you control.

```tsx
// 1 — signup form
import { buildClerkAcceptanceMetadata } from 'terms-acceptance/clerk';

await signUp.create({
  emailAddress,
  password,
  unsafeMetadata: buildClerkAcceptanceMetadata(required, { method: 'signup-checkbox', locale }),
});
```

```ts
// 2 — app/api/webhooks/clerk/route.ts
import { Webhook } from 'svix';
import { createClerkWebhookHandler } from 'terms-acceptance/clerk';

const svix = new Webhook(process.env.CLERK_WEBHOOK_SECRET!);

const handle = createClerkWebhookHandler({
  service: terms,
  required: () => selectRequiredDocuments(corpus, { product: 'cloc' }),
  verify: (body, headers) => svix.verify(body, headers) as ClerkWebhookEvent,
  ipSalt: process.env.TERMS_IP_SALT,
});

export async function POST(req: Request) {
  const raw = await req.text();                       // raw bytes — svix verifies these
  const result = await handle(raw, Object.fromEntries(req.headers));
  return Response.json({ recorded: result.recorded.length });
}
```

The handler **rejects any claim whose `documentId` + `version` + `sha256` does not match a
published document.** A value that arrived from a browser is a claim; it becomes evidence only
once the server has checked it against the corpus and stored it somewhere the browser cannot
reach.

### Firebase Auth — Ever Rec

Firestore via the Admin SDK. The document id is derived deterministically from
`(subject, tenant, document, version)` and written with `DocumentReference.create()`, which fails
if the document exists — append-only semantics and duplicate rejection for free.

```ts
import { getFirestore } from 'firebase-admin/firestore';
import { FirebaseAcceptanceAdapter, FIRESTORE_RULES, createAcceptCallable } from 'terms-acceptance/firebase';

const terms = new TermsAcceptanceService({
  adapter: new FirebaseAcceptanceAdapter({ firestore: getFirestore() }),
  corpus,
});

export const acceptTerms = onCall(createAcceptCallable({ service: terms, required: async () => required }));
```

Deploy `FIRESTORE_RULES` (or fold it into yours): clients may read their own records and nothing
else; create/update/delete are denied to everything rules apply to. The Admin SDK bypasses rules,
so the server still writes.

### Anything else

`SqlAcceptanceAdapter` takes any `{ query(sql, params) → { rows } }`: `pg.Pool`, a Drizzle or
Kysely raw executor, a MySQL driver (`placeholder: '?'`), a shim. `MemoryAcceptanceAdapter` is
the reference implementation and is genuinely useful in integration tests. Or implement
`AcceptanceStorageAdapter` — it is four methods, and `init` is optional.

---

## React

```tsx
import { TermsCheckbox, ReacceptModal, useTermsGate } from 'terms-acceptance/react';
import type { AcceptancePayload } from 'terms-acceptance/react';

function SignUp({ required }) {
  const [terms, setTerms] = useState<AcceptancePayload | null>(null);

  return (
    <form onSubmit={(e) => { e.preventDefault(); signUp({ email, password, terms }); }}>
      {/* … */}
      <TermsCheckbox documents={required} onChange={setTerms} />
      <button disabled={!terms}>Create account</button>
    </form>
  );
}
```

`onChange` hands you the payload — document ids, versions **and digests** — and that payload is
the thing you post. The type is `AcceptancePayload | null`, so the value that gates the button
and the value that reaches the server are the same object. Dropping it is now a visible act
rather than an omission. (The component also mirrors the versions into hidden inputs, so a
progressively-enhanced plain `<form>` POST still carries the evidence.)

The label is yours: pass `renderLabel` — the sentence around the links differs per locale and per
legal entity, and it is not a component's business to guess it.

```tsx
function App() {
  const gate = useTermsGate();   // GET /api/terms/status, POST /api/terms/accept

  return (
    <>
      <ReacceptModal status={gate.status} onAccept={gate.accept} onSignOut={signOut} />
      {!gate.blocked && <Dashboard />}
    </>
  );
}
```

`ReacceptModal` renders only when `status.blocking` is non-empty, and while open it has no
dismiss button, no backdrop click and no Escape. A material change is exactly the case where
"remind me later" is not a real option — and a modal that can be dismissed produces no record.
Non-material changes never reach it; they arrive as `status.notices` and belong in a banner.

> The client gate is UI. **Enforce it on the server too** — a session that has not accepted
> should not get data. A client-side gate on its own is a suggestion.

---

## Privacy

`ipHash` is a **salted** sha256, and `buildRecord` refuses anything that is not a 64-char hex
digest — passing a raw IP throws. Store the address itself and an audit trail becomes a tracking
database; a salted digest still lets you say "this acceptance came from a different address than
that one" without retaining the address. The salt must be a per-deployment secret of at least 16
characters: there are only 2³² IPv4 addresses, so an *unsalted* IP hash is reversible in seconds.

`userAgent` is truncated to 512 characters. `metadata` is free-form and non-authoritative —
request ids, form ids, campaign — never anything you would not want in a disclosure bundle.

Both are nullable. Recording neither is a legitimate configuration.

---

## API

```ts
new TermsAcceptanceService({ adapter, corpus?, ipSalt?, materiality?, onTextMismatch?, verifyOnRead?, now?, newId? })

terms.init()                                    // create tables/indexes if the adapter supports it
terms.record(input)                             // → AcceptanceRecord (idempotent)
terms.recordMany(documents, common)             // → AcceptanceRecord[]
terms.history({ subjectId, tenantId?, documentIds? })
terms.latest(subjectId, documentId, tenantId?)
terms.status(subjectId, required, options?)     // → AcceptanceStatus
terms.hashIp(ip)                                // → salted digest | null
```

```ts
evaluateAcceptance(required, accepted, options?)          // pure
decideMateriality(documentId, from, to, history?, policy?)
selectRequiredDocuments(corpusIndex, { product, locale?, documents?, url? })
findDocument(corpusIndex, documentId, locale?)
assertPublishedText(corpusIndex, documentId, version, sha256)
buildRecord(input) · assertIntact(record) · isIntact(record) · fingerprintOf(record)
sha256Hex(text) · hashIp(ip, salt) · canonicalJson(value)
compareVersions(a, b) · isMajorBump(from, to) · parseVersion(v)
```

Errors: `InvalidAcceptanceError`, `DuplicateAcceptanceError`, `ImmutableRecordError`,
`TamperedRecordError`, `UndeclaredMaterialityError` — all extending `TermsAcceptanceError`.

`sha256Hex` is a dependency-free synchronous implementation rather than `node:crypto`, because
this package runs on Node servers, edge runtimes, browsers and React Native. It is verified
against `node:crypto` and the published vectors in the test suite — if the two ever disagreed,
every record in the fleet would point at nothing.

---

## Development

```bash
npm install
npm run typecheck
npm test
npm run build      # dual ESM + CJS, types, both verified to load
npm run check      # all three
```

Branches follow `develop → stage → main`. Contributions go to `develop`.

## Licence

MIT © Ever Co. LTD — separate companies consume this package, so the licence is deliberately
permissive and the package name deliberately entity-neutral.
