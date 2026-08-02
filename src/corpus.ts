/**
 * Reading a legal corpus index.
 *
 * The corpus (`@ever-co/legal`, `@cloc-co/legal`, `@ever-digital/legal`, …) emits a
 * `dist/index.json` with one record per document × product × locale, each already
 * carrying a `sha256` of its source text. That digest is what an acceptance pins
 * itself to, which is what makes an acceptance reproducible years later: re-run the
 * corpus build at that tag, re-hash, compare.
 */

import type { CorpusDocument, CorpusIndex, RequiredDocument } from './types.js';

/** Compose the stable id stored in a record: `<document>:<product>`. */
export function documentIdOf(doc: Pick<CorpusDocument, 'document' | 'product'>): string {
	return `${doc.document}:${doc.product}`;
}

export interface SelectOptions {
	/** Product id as used by the corpus, e.g. `gauzy`. */
	product: string;
	/**
	 * Which document types gate access. Defaults to `['tos', 'privacy']` — the two
	 * every product in the fleet must have accepted.
	 */
	documents?: string[];
	/** Preferred locale; falls back to `en`, then to whatever exists. */
	locale?: string;
	/** Build the public URL for a document. */
	url?: (doc: CorpusDocument) => string;
	/** Human title for a document type. */
	title?: (doc: CorpusDocument) => string;
	/** Skip documents the corpus has not marked publishable. Default `true`. */
	requirePublishable?: boolean;
}

const DEFAULT_TITLES: Record<string, string> = {
	tos: 'Terms of Service',
	privacy: 'Privacy Policy',
	cookies: 'Cookie Policy',
	dpa: 'Data Processing Agreement',
	aup: 'Acceptable Use Policy',
	refund: 'Refund Policy',
	security: 'Security Overview',
	subprocessors: 'Sub-processors',
};

/**
 * Turn a corpus index into the {@link RequiredDocument} list for one product.
 *
 * Locale resolution is deliberate: a person must be shown, and pinned to, the text
 * in the language they actually read. If the requested locale is missing we fall
 * back to `en` and the record still stores which locale was served.
 */
export function selectRequiredDocuments(index: CorpusIndex, options: SelectOptions): RequiredDocument[] {
	const wanted = options.documents ?? ['tos', 'privacy'];
	const locale = options.locale ?? 'en';
	const requirePublishable = options.requirePublishable !== false;

	const out: RequiredDocument[] = [];
	for (const type of wanted) {
		const candidates = index.documents.filter(
			(d) => d.document === type && d.product === options.product && (!requirePublishable || d.publishable !== false)
		);
		if (candidates.length === 0) continue;

		const chosen =
			candidates.find((d) => d.locale === locale) ??
			candidates.find((d) => d.locale === locale.split('-')[0]) ??
			candidates.find((d) => d.locale === 'en') ??
			candidates[0]!;

		const doc: RequiredDocument = {
			documentId: documentIdOf(chosen),
			version: chosen.version,
			sha256: chosen.sha256,
			locale: chosen.locale,
			title: options.title?.(chosen) ?? DEFAULT_TITLES[type] ?? type,
		};
		if (options.url) doc.url = options.url(chosen);
		if (chosen.effectiveDate) doc.effectiveDate = chosen.effectiveDate;
		if (chosen.history) doc.history = chosen.history;
		out.push(doc);
	}
	return out;
}

/** Look up one document by its `<document>:<product>` id and a locale. */
export function findDocument(index: CorpusIndex, documentId: string, locale = 'en'): CorpusDocument | null {
	const matches = index.documents.filter((d) => documentIdOf(d) === documentId);
	if (matches.length === 0) return null;
	return (
		matches.find((d) => d.locale === locale) ??
		matches.find((d) => d.locale === locale.split('-')[0]) ??
		matches.find((d) => d.locale === 'en') ??
		matches[0]!
	);
}

/**
 * Guard against accepting a document the corpus does not actually publish.
 *
 * Without this a bug in a signup form could record an acceptance against a sha256
 * that no published text ever had — evidence pointing at nothing.
 */
export function assertPublishedText(index: CorpusIndex, documentId: string, version: string, sha256: string): void {
	const matches = index.documents.filter((d) => documentIdOf(d) === documentId);
	const exact = matches.find((d) => d.version === version && d.sha256 === sha256);
	if (exact) return;
	const historical = matches.some((d) =>
		(d.history ?? []).some((h) => h.version === version && h.sha256 === sha256)
	);
	if (historical) return;
	throw new Error(
		`terms-acceptance: ${documentId}@${version} sha256 ${sha256.slice(0, 12)}… is not in the corpus index. ` +
			`Refusing to record an acceptance against text that was never published.`
	);
}
