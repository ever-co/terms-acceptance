import { assertPublishedText } from './corpus.js';
import { DuplicateAcceptanceError } from './errors.js';
import { evaluateAcceptance } from './evaluate.js';
import { hashIp } from './hash.js';
import { adoptRecord, buildRecord } from './record.js';
import type {
	AcceptanceInput,
	AcceptanceQuery,
	AcceptanceRecord,
	AcceptanceStatus,
	AcceptanceStorageAdapter,
	CorpusIndex,
	EvaluateOptions,
	MaterialityPolicy,
	RequiredDocument,
} from './types.js';

export interface ServiceOptions {
	adapter: AcceptanceStorageAdapter;
	/**
	 * The corpus index. When supplied, every write is checked against it so an
	 * acceptance can never point at text the corpus never published.
	 */
	corpus?: CorpusIndex;
	/** Per-deployment secret used by {@link TermsAcceptanceService.hashIp}. */
	ipSalt?: string;
	/** Default `'declared-or-semver'`. */
	materiality?: MaterialityPolicy;
	/** Default `'block'`. */
	onTextMismatch?: EvaluateOptions['onTextMismatch'];
	/** Verify the fingerprint of every record read back from storage. Default `true`. */
	verifyOnRead?: boolean;
	/** Injectable clock, for tests and back-dated imports. */
	now?: () => Date;
	/** Injectable id generator. */
	newId?: () => string;
}

/**
 * The storage-agnostic core.
 *
 * Everything the fleet needs is here: write an acceptance, read a subject's
 * acceptances, and ask whether they are up to date. Which database it lands in is
 * the adapter's problem; whether a change is material is the corpus's decision.
 */
export class TermsAcceptanceService {
	readonly adapter: AcceptanceStorageAdapter;
	private readonly corpus: CorpusIndex | undefined;
	private readonly ipSalt: string | undefined;
	private readonly materiality: MaterialityPolicy;
	private readonly onTextMismatch: EvaluateOptions['onTextMismatch'];
	private readonly verifyOnRead: boolean;
	private readonly now: () => Date;
	private readonly newId: (() => string) | undefined;

	constructor(options: ServiceOptions) {
		this.adapter = options.adapter;
		this.corpus = options.corpus;
		this.ipSalt = options.ipSalt;
		this.materiality = options.materiality ?? 'declared-or-semver';
		this.onTextMismatch = options.onTextMismatch ?? 'block';
		this.verifyOnRead = options.verifyOnRead !== false;
		this.now = options.now ?? (() => new Date());
		this.newId = options.newId;
	}

	/** Create tables / indexes if the adapter supports it. */
	async init(): Promise<void> {
		await this.adapter.init?.();
	}

	/**
	 * Record an acceptance.
	 *
	 * Idempotent: re-recording the same `(subject, tenant, document, version)` returns
	 * the record that already exists rather than writing a second one or throwing. A
	 * double-submitted signup form must not produce two pieces of evidence that
	 * disagree about the time.
	 */
	async record(input: AcceptanceInput): Promise<AcceptanceRecord> {
		if (this.corpus) assertPublishedText(this.corpus, input.documentId, input.version, input.sha256);

		const built = buildRecord(input, {
			now: this.now,
			...(this.newId ? { newId: this.newId } : {}),
		});

		try {
			return adoptRecord(await this.adapter.put(built), { verify: this.verifyOnRead });
		} catch (error) {
			if (error instanceof DuplicateAcceptanceError) {
				const existing = await this.adapter.latest({
					subjectId: built.subjectId,
					tenantId: built.tenantId ?? null,
					documentId: built.documentId,
				});
				if (existing) return adoptRecord(existing, { verify: this.verifyOnRead });
			}
			throw error;
		}
	}

	/** Record several documents at once — the usual signup case (ToS + Privacy). */
	async recordMany(
		documents: readonly RequiredDocument[],
		common: Omit<AcceptanceInput, 'documentId' | 'version' | 'sha256' | 'locale'> & { locale?: string }
	): Promise<AcceptanceRecord[]> {
		const out: AcceptanceRecord[] = [];
		for (const doc of documents) {
			out.push(
				await this.record({
					...common,
					documentId: doc.documentId,
					version: doc.version,
					sha256: doc.sha256,
					locale: common.locale ?? doc.locale,
				})
			);
		}
		return out;
	}

	/** Every acceptance on file for a subject, newest first, integrity-checked. */
	async history(query: AcceptanceQuery): Promise<AcceptanceRecord[]> {
		const rows = await this.adapter.list(query);
		return rows.map((row) => adoptRecord(row, { verify: this.verifyOnRead }));
	}

	/** The newest acceptance for one document, or `null`. */
	async latest(subjectId: string, documentId: string, tenantId: string | null = null): Promise<AcceptanceRecord | null> {
		const row = await this.adapter.latest({ subjectId, tenantId, documentId });
		return row ? adoptRecord(row, { verify: this.verifyOnRead }) : null;
	}

	/**
	 * Ask whether a subject is up to date.
	 *
	 * Call this on every login and on session refresh. `status.blocking` is what the
	 * re-accept modal renders; `status.notices` is what a dismissible banner renders.
	 */
	async status(
		subjectId: string,
		required: readonly RequiredDocument[],
		options: { tenantId?: string | null } & EvaluateOptions = {}
	): Promise<AcceptanceStatus> {
		const accepted = await this.history({
			subjectId,
			tenantId: options.tenantId ?? null,
			documentIds: required.map((d) => d.documentId),
		});
		return evaluateAcceptance(required, accepted, {
			materiality: options.materiality ?? this.materiality,
			onTextMismatch: options.onTextMismatch ?? this.onTextMismatch,
		});
	}

	/** Salted IP hash using the service's configured salt. */
	hashIp(ip: string | null | undefined): string | null {
		if (!this.ipSalt) return null;
		return hashIp(ip, this.ipSalt);
	}
}

/** Functional constructor, for people who dislike `new`. */
export function createTermsAcceptance(options: ServiceOptions): TermsAcceptanceService {
	return new TermsAcceptanceService(options);
}
