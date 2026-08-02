import { decideMateriality } from './materiality.js';
import { compareVersions } from './semver.js';
import type {
	AcceptanceRecord,
	AcceptanceStatus,
	EvaluateOptions,
	PendingDocument,
	RequiredDocument,
} from './types.js';

/** Newest acceptance per documentId. */
function newestByDocument(records: readonly AcceptanceRecord[]): Map<string, AcceptanceRecord> {
	const best = new Map<string, AcceptanceRecord>();
	for (const record of records) {
		const current = best.get(record.documentId);
		if (!current) {
			best.set(record.documentId, record);
			continue;
		}
		const byVersion = compareVersions(record.version, current.version);
		const newer = byVersion === 1 || (byVersion === 0 && record.acceptedAt > current.acceptedAt);
		if (newer) best.set(record.documentId, record);
	}
	return best;
}

/**
 * Compare what a subject has accepted against what the corpus currently requires.
 *
 * Pure and synchronous — no storage, no clock, no network — so it is safe to run in
 * a login hook, in middleware, or in a test.
 */
export function evaluateAcceptance(
	required: readonly RequiredDocument[],
	accepted: readonly AcceptanceRecord[],
	options: EvaluateOptions = {}
): AcceptanceStatus {
	const policy = options.materiality ?? 'declared-or-semver';
	const onMismatch = options.onTextMismatch ?? 'block';
	const latest = newestByDocument(accepted);

	const blocking: PendingDocument[] = [];
	const notices: PendingDocument[] = [];
	const current: string[] = [];

	for (const doc of required) {
		const record = latest.get(doc.documentId) ?? null;

		if (!record) {
			blocking.push(pending(doc, null, 'never-accepted', true, []));
			continue;
		}

		const cmp = compareVersions(record.version, doc.version);

		if (cmp === 0) {
			if (record.sha256 === doc.sha256 || onMismatch === 'ignore') {
				current.push(doc.documentId);
			} else if (onMismatch === 'block') {
				blocking.push(pending(doc, record, 'text-mismatch', true, []));
			} else {
				notices.push(pending(doc, record, 'text-mismatch', false, []));
			}
			continue;
		}

		if (cmp === 1) {
			// They accepted something newer than we are asking for — a stale cache on our
			// side, or a rollback. Never re-prompt for that; it is already covered.
			current.push(doc.documentId);
			continue;
		}

		const verdict = decideMateriality(doc.documentId, record.version, doc.version, doc.history, policy);
		if (verdict.material) {
			blocking.push(pending(doc, record, 'material-change', true, verdict.changes));
		} else {
			notices.push(pending(doc, record, 'minor-change', false, verdict.changes));
		}
	}

	return { satisfied: blocking.length === 0, blocking, notices, current };
}

function pending(
	doc: RequiredDocument,
	record: AcceptanceRecord | null,
	reason: PendingDocument['reason'],
	blocking: boolean,
	changes: PendingDocument['changes']
): PendingDocument {
	const out: PendingDocument = {
		documentId: doc.documentId,
		reason,
		blocking,
		acceptedVersion: record?.version ?? null,
		acceptedAt: record?.acceptedAt ?? null,
		requiredVersion: doc.version,
		requiredSha256: doc.sha256,
		changes,
	};
	if (doc.title !== undefined) out.title = doc.title;
	if (doc.url !== undefined) out.url = doc.url;
	return out;
}
