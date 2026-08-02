/**
 * Core types for `terms-acceptance`.
 *
 * The unit of evidence is an {@link AcceptanceRecord}: an append-only row that says
 * *who* accepted *which exact text* (pinned by sha256), *when*, *in what language*,
 * *from roughly where* (a salted hash of the IP, never the IP), *with what client*,
 * and — critically — *how* consent was obtained.
 */

/**
 * How the acceptance was obtained. Proving the mechanism matters as much as
 * proving the fact: a checkbox at signup and a blocking modal shown to an existing
 * user are legally different events.
 *
 * The union is open (`(string & {})`) so a consumer can record a bespoke flow, but
 * the listed values are the ones the fleet uses and the ones tooling understands.
 */
export type AcceptanceMethod =
	| 'signup-checkbox'
	| 'reaccept-modal'
	| 'checkout'
	| 'invite-accept'
	| 'sso-provisioning'
	| 'api'
	| 'cli'
	| 'admin-recorded'
	| 'import'
	// eslint-disable-next-line @typescript-eslint/ban-types
	| (string & {});

/** A semantic version string, e.g. `2.1.0`. Pre-release / build metadata is tolerated. */
export type SemVer = string;

/**
 * A single, immutable acceptance event.
 *
 * `sha256` is the digest of the *source* text of the document as published by the
 * legal corpus (`dist/index.json` of `@ever-co/legal` and friends). It is what makes
 * the record provable: the exact wording the person agreed to can be reproduced and
 * re-hashed years later.
 */
export interface AcceptanceRecord {
	/** Storage-assigned or caller-supplied identifier for this record. */
	readonly id: string;
	/** The person or account the acceptance belongs to (your user id, Clerk id, Firebase uid…). */
	readonly subjectId: string;
	/** Optional tenant / organization scope, when one user can accept per-tenant. */
	readonly tenantId?: string | null;
	/** Stable document identifier, e.g. `tos:gauzy` or `privacy:ever-works`. */
	readonly documentId: string;
	/** Version of the document that was accepted. */
	readonly version: SemVer;
	/** Lowercase hex sha256 (64 chars) of the exact document source that was shown. */
	readonly sha256: string;
	/** ISO-8601 UTC instant the acceptance happened. */
	readonly acceptedAt: string;
	/** BCP-47 locale of the text that was shown, e.g. `en`, `bg`, `fr-CA`. */
	readonly locale: string;
	/** Salted sha256 of the client IP. Never a raw IP. `null` when not collected. */
	readonly ipHash: string | null;
	/** Verbatim user-agent string of the client, truncated. `null` when not collected. */
	readonly userAgent: string | null;
	/** How consent was obtained. */
	readonly method: AcceptanceMethod;
	/** Free-form, non-authoritative context (request id, campaign, form id…). */
	readonly metadata?: Readonly<Record<string, unknown>> | null;
	/**
	 * Integrity digest over the canonical form of every other field.
	 * Recompute with {@link fingerprintOf} to detect tampering in storage.
	 */
	readonly fingerprint: string;
}

/** What a caller supplies; the service fills in `id`, `acceptedAt` and `fingerprint`. */
export interface AcceptanceInput {
	subjectId: string;
	tenantId?: string | null;
	documentId: string;
	version: SemVer;
	sha256: string;
	locale: string;
	method: AcceptanceMethod;
	ipHash?: string | null;
	userAgent?: string | null;
	metadata?: Record<string, unknown> | null;
	/** Override the clock (tests, back-dated imports). ISO-8601 UTC. */
	acceptedAt?: string;
	/** Override the generated id (idempotent replays). */
	id?: string;
}

/** Narrowing filter for reads. */
export interface AcceptanceQuery {
	subjectId: string;
	tenantId?: string | null;
	/** Restrict to these document ids. Omit for all. */
	documentIds?: string[];
}

/**
 * Storage contract. Deliberately tiny — four methods, no update, no delete.
 *
 * An adapter MUST be append-only. `put` must reject a second write for the same
 * `(subjectId, tenantId, documentId, version)` tuple with an
 * {@link DuplicateAcceptanceError}; the service catches it and returns the
 * pre-existing record so a double-clicked checkbox is harmless.
 */
export interface AcceptanceStorageAdapter {
	/** Human-readable adapter name, used in error messages. */
	readonly name: string;
	/** Append one record. MUST NOT overwrite. */
	put(record: AcceptanceRecord): Promise<AcceptanceRecord>;
	/** All records for a subject, newest first. */
	list(query: AcceptanceQuery): Promise<AcceptanceRecord[]>;
	/** The most recent record for one document, or `null`. */
	latest(query: AcceptanceQuery & { documentId: string }): Promise<AcceptanceRecord | null>;
	/** Optional: create tables / indexes. Called by consumers that want auto-migration. */
	init?(): Promise<void>;
}

/* ------------------------------------------------------------------ corpus */

/**
 * One document as published by the legal corpus build.
 *
 * This mirrors the record shape emitted into `dist/index.json` by `@ever-co/legal`
 * (`document`, `product`, `locale`, `version`, `sha256`, …) and adds the optional
 * `history`, which is where materiality is *declared*.
 */
export interface CorpusDocument {
	/** Document type, e.g. `tos`, `privacy`, `cookies`, `dpa`. */
	document: string;
	/** Product the rendering belongs to, e.g. `gauzy`, `ever-works`. */
	product: string;
	/** BCP-47 locale of this rendering. */
	locale: string;
	/** Current published version. */
	version: SemVer;
	/** Lowercase hex sha256 of the current source text. */
	sha256: string;
	/** ISO date the current version takes effect. */
	effectiveDate?: string;
	/** Whether the corpus considers this rendering fit to publish. */
	publishable?: boolean;
	/**
	 * Declared version history, newest or oldest order — both are handled.
	 * `material: true` means "everyone must accept again".
	 *
	 * When present this is authoritative and the semver heuristic is not consulted.
	 */
	history?: CorpusVersionEntry[];
	/** Anything else the corpus emits is carried through untouched. */
	[key: string]: unknown;
}

/** One declared version of a document. */
export interface CorpusVersionEntry {
	version: SemVer;
	/** Declared materiality. `true` → blocking re-acceptance for anyone on an older version. */
	material: boolean;
	sha256?: string;
	effectiveDate?: string;
	/** Short human summary of what changed, surfaced in the re-accept modal. */
	summary?: string;
}

/** The shape of a corpus `dist/index.json`. */
export interface CorpusIndex {
	corpus?: string;
	generatedFrom?: string;
	documents: CorpusDocument[];
	[key: string]: unknown;
}

/** A document a subject is required to have accepted. */
export interface RequiredDocument {
	/** Stable id used in records, e.g. `tos:gauzy`. */
	documentId: string;
	version: SemVer;
	sha256: string;
	locale: string;
	/** Where the user can read it. */
	url?: string;
	/** Human title for the checkbox / modal. */
	title?: string;
	effectiveDate?: string;
	history?: CorpusVersionEntry[];
}

/* ------------------------------------------------------------- evaluation */

/** Why a document is outstanding. */
export type PendingReason =
	/** No acceptance on file at all. */
	| 'never-accepted'
	/** A version declared material (or a major bump) was published since. */
	| 'material-change'
	/** A non-material change was published since. Notice only. */
	| 'minor-change'
	/** Accepted version matches but the text hash does not — the corpus changed under us. */
	| 'text-mismatch';

/** One outstanding document, with everything a UI needs to render it. */
export interface PendingDocument {
	documentId: string;
	reason: PendingReason;
	/** `true` → must be accepted before the session may continue. */
	blocking: boolean;
	/** What the subject accepted previously, if anything. */
	acceptedVersion: SemVer | null;
	acceptedAt: string | null;
	/** What they need to accept now. */
	requiredVersion: SemVer;
	requiredSha256: string;
	title?: string;
	url?: string;
	/** Summaries of the intervening versions, oldest → newest, when the corpus declares them. */
	changes: CorpusVersionEntry[];
}

/** Result of {@link evaluateAcceptance}. */
export interface AcceptanceStatus {
	/** `true` when nothing is blocking. Notices may still be present. */
	satisfied: boolean;
	/** Documents that must be accepted before continuing. */
	blocking: PendingDocument[];
	/** Documents that changed non-materially — show a banner, do not gate. */
	notices: PendingDocument[];
	/** Documents already accepted at the current version. */
	current: string[];
}

/** How materiality is decided. */
export type MaterialityPolicy =
	/**
	 * Use the corpus `history` when it is declared; otherwise fall back to semver
	 * (MAJOR bump = material). The default.
	 */
	| 'declared-or-semver'
	/**
	 * Only the corpus may decide. A document without a usable `history` throws,
	 * so nobody can quietly guess at runtime.
	 */
	| 'declared'
	/** Ignore `history`; MAJOR bump = material. Escape hatch for corpora with no history. */
	| 'semver';

/** Options for {@link evaluateAcceptance}. */
export interface EvaluateOptions {
	/** Default `'declared-or-semver'`. */
	materiality?: MaterialityPolicy;
	/**
	 * What to do when the accepted version equals the required version but the
	 * sha256 differs. Default `'block'` — the safe reading is that the person never
	 * saw this text.
	 */
	onTextMismatch?: 'block' | 'notice' | 'ignore';
}
