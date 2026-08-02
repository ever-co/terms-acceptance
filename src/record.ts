import { InvalidAcceptanceError, TamperedRecordError } from './errors.js';
import { canonicalJson, isSha256Hex, sha256Hex } from './hash.js';
import type { AcceptanceInput, AcceptanceRecord } from './types.js';

/** Fields covered by the integrity fingerprint, in canonical order. */
const FINGERPRINTED = [
	'id',
	'subjectId',
	'tenantId',
	'documentId',
	'version',
	'sha256',
	'acceptedAt',
	'locale',
	'ipHash',
	'userAgent',
	'method',
	'metadata',
] as const;

/**
 * Digest over every meaningful field of a record.
 *
 * Storage can be edited by anyone with database access; the fingerprint means such
 * an edit is *detectable*. It is not a signature — it does not stop a determined
 * insider who recomputes it — but it turns silent tampering into loud tampering,
 * which is the difference between an audit trail and a table of claims.
 */
export function fingerprintOf(record: Omit<AcceptanceRecord, 'fingerprint'> & { fingerprint?: string }): string {
	const subset: Record<string, unknown> = {};
	for (const key of FINGERPRINTED) {
		const value = (record as Record<string, unknown>)[key];
		subset[key] = value === undefined ? null : value;
	}
	return sha256Hex(`terms-acceptance/record/v1\n${canonicalJson(subset)}`);
}

/** Recompute and compare. Throws {@link TamperedRecordError} on mismatch. */
export function assertIntact(record: AcceptanceRecord): AcceptanceRecord {
	const expected = fingerprintOf(record);
	if (expected !== record.fingerprint) {
		throw new TamperedRecordError(record.id, expected, record.fingerprint);
	}
	return record;
}

/** Non-throwing form of {@link assertIntact}. */
export function isIntact(record: AcceptanceRecord): boolean {
	return fingerprintOf(record) === record.fingerprint;
}

const MAX_USER_AGENT = 512;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function requireString(value: unknown, field: string, max = 256): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new InvalidAcceptanceError(field, 'must be a non-empty string');
	}
	if (value.length > max) throw new InvalidAcceptanceError(field, `must be at most ${max} characters`);
	return value.trim();
}

/**
 * Validate an input, fill in `id`, `acceptedAt` and `fingerprint`, and deep-freeze
 * the result. The returned object throws on assignment in strict mode — records are
 * evidence, and evidence that can be edited in place is not evidence.
 */
export function buildRecord(
	input: AcceptanceInput,
	options: { now?: () => Date; newId?: () => string } = {}
): AcceptanceRecord {
	const now = options.now ?? (() => new Date());
	const newId = options.newId ?? defaultId;

	const subjectId = requireString(input.subjectId, 'subjectId');
	const documentId = requireString(input.documentId, 'documentId');
	const version = requireString(input.version, 'version', 64);
	const method = requireString(input.method, 'method', 64);
	const locale = requireString(input.locale, 'locale', 35);
	if (!LOCALE.test(locale)) throw new InvalidAcceptanceError('locale', 'must be a BCP-47 tag such as "en" or "fr-CA"');

	if (!isSha256Hex(input.sha256)) {
		throw new InvalidAcceptanceError(
			'sha256',
			'must be a lowercase 64-character hex digest of the exact document source ' +
				'(take it from the corpus index — do not compute it from rendered HTML)'
		);
	}

	const acceptedAt = input.acceptedAt ?? now().toISOString();
	if (!ISO.test(acceptedAt)) throw new InvalidAcceptanceError('acceptedAt', 'must be an ISO-8601 instant');

	if (input.ipHash != null && !isSha256Hex(input.ipHash)) {
		throw new InvalidAcceptanceError(
			'ipHash',
			'must be a salted sha256 (use hashIp()). Raw IP addresses must never be stored'
		);
	}

	const tenantId = input.tenantId == null ? null : requireString(input.tenantId, 'tenantId');
	const userAgent =
		input.userAgent == null || input.userAgent === '' ? null : String(input.userAgent).slice(0, MAX_USER_AGENT);

	const base = {
		id: input.id ? requireString(input.id, 'id', 128) : newId(),
		subjectId,
		tenantId,
		documentId,
		version,
		sha256: input.sha256,
		acceptedAt,
		locale,
		ipHash: input.ipHash ?? null,
		userAgent,
		method,
		metadata: input.metadata == null ? null : { ...input.metadata },
	};

	return freezeRecord({ ...base, fingerprint: fingerprintOf(base) });
}

/** Rehydrate a record read back from storage: verify integrity, then freeze. */
export function adoptRecord(raw: AcceptanceRecord, options: { verify?: boolean } = {}): AcceptanceRecord {
	if (options.verify !== false) assertIntact(raw);
	return freezeRecord(raw);
}

/** Deep-freeze a record and its metadata. */
export function freezeRecord(record: AcceptanceRecord): AcceptanceRecord {
	if (record.metadata) Object.freeze(record.metadata);
	return Object.freeze(record);
}

let counter = 0;

/** Random-enough id without a uuid dependency: time + counter + randomness. */
function defaultId(): string {
	const rand =
		typeof globalThis.crypto?.randomUUID === 'function'
			? globalThis.crypto.randomUUID().replace(/-/g, '')
			: Math.random().toString(16).slice(2).padStart(13, '0') + Math.random().toString(16).slice(2).padStart(13, '0');
	counter = (counter + 1) % 0xffff;
	return `ta_${Date.now().toString(36)}${counter.toString(36).padStart(4, '0')}${rand.slice(0, 16)}`;
}
