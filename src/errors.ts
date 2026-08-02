/** Base class for everything this package throws. */
export class TermsAcceptanceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

/** An {@link AcceptanceInput} failed validation before it could be written. */
export class InvalidAcceptanceError extends TermsAcceptanceError {
	readonly field: string;
	constructor(field: string, message: string) {
		super(`invalid acceptance: ${field} — ${message}`);
		this.field = field;
	}
}

/**
 * The adapter already holds a record for this
 * `(subjectId, tenantId, documentId, version)` tuple.
 *
 * Adapters throw it; {@link TermsAcceptanceService.record} catches it and returns
 * the existing record, so replays are idempotent rather than fatal.
 */
export class DuplicateAcceptanceError extends TermsAcceptanceError {
	readonly subjectId: string;
	readonly documentId: string;
	readonly version: string;
	constructor(subjectId: string, documentId: string, version: string) {
		super(`acceptance already recorded for ${subjectId} / ${documentId}@${version}`);
		this.subjectId = subjectId;
		this.documentId = documentId;
		this.version = version;
	}
}

/** Someone tried to change or delete a stored acceptance. Records are evidence; they do not change. */
export class ImmutableRecordError extends TermsAcceptanceError {
	constructor(operation: string) {
		super(
			`acceptance records are append-only: '${operation}' is not supported. ` +
				`Record a new acceptance instead of modifying the old one.`
		);
	}
}

/** A stored record's fingerprint does not match its contents. */
export class TamperedRecordError extends TermsAcceptanceError {
	readonly id: string;
	constructor(id: string, expected: string, actual: string) {
		super(`acceptance ${id} failed integrity check: fingerprint ${actual} != ${expected}`);
		this.id = id;
	}
}

/** Materiality policy is `'declared'` but the corpus declares no usable history. */
export class UndeclaredMaterialityError extends TermsAcceptanceError {
	readonly documentId: string;
	constructor(documentId: string, from: string, to: string) {
		super(
			`materiality for ${documentId} ${from} → ${to} is not declared in the corpus. ` +
				`Declare it in the document's 'history' (material: true|false) — ` +
				`materiality is a legal decision and must not be guessed at runtime.`
		);
		this.documentId = documentId;
	}
}
