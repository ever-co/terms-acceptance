import { UndeclaredMaterialityError } from './errors.js';
import { compareVersions, isMajorBump } from './semver.js';
import type { CorpusVersionEntry, MaterialityPolicy, RequiredDocument } from './types.js';

/** Outcome of a materiality question. */
export interface MaterialityVerdict {
	material: boolean;
	/** How it was decided — useful in logs and in the "why am I seeing this?" copy. */
	source: 'declared' | 'semver' | 'unchanged';
	/** The declared entries strictly newer than the accepted version, oldest → newest. */
	changes: CorpusVersionEntry[];
}

/** Sort a history oldest → newest, tolerating either input order. */
export function sortHistory(history: CorpusVersionEntry[]): CorpusVersionEntry[] {
	return [...history].sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * Decide whether moving a subject from `from` to `to` requires a fresh acceptance.
 *
 * The corpus decides. `history` in the corpus index carries `material: true|false`
 * per version, set by whoever published the text; this function only *reads* that
 * decision and, under the default policy, falls back to "a MAJOR bump is material"
 * when nothing is declared. That fallback is a convenience for corpora that have not
 * added a history yet — set the policy to `'declared'` to make an undeclared change
 * an error instead, so materiality can never be improvised in production.
 */
export function decideMateriality(
	documentId: string,
	from: string,
	to: string,
	history: CorpusVersionEntry[] | undefined,
	policy: MaterialityPolicy = 'declared-or-semver'
): MaterialityVerdict {
	if (compareVersions(from, to) === 0) return { material: false, source: 'unchanged', changes: [] };

	const declared =
		policy === 'semver' || !history?.length
			? []
			: sortHistory(history).filter(
					(entry) => compareVersions(entry.version, from) === 1 && compareVersions(entry.version, to) <= 0
				);

	if (declared.length > 0) {
		return { material: declared.some((entry) => entry.material === true), source: 'declared', changes: declared };
	}

	if (policy === 'declared') throw new UndeclaredMaterialityError(documentId, from, to);

	return { material: isMajorBump(from, to), source: 'semver', changes: [] };
}

/** Convenience wrapper over a {@link RequiredDocument}. */
export function isMaterialChange(
	required: RequiredDocument,
	acceptedVersion: string,
	policy: MaterialityPolicy = 'declared-or-semver'
): boolean {
	return decideMateriality(required.documentId, acceptedVersion, required.version, required.history, policy).material;
}
