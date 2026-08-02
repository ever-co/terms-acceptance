import { sha256Hex } from '../src/hash.js';
import type { CorpusIndex, RequiredDocument } from '../src/types.js';

/** Stand-ins for the real markdown a corpus would hash. */
export const TOS_V1_TEXT = '# Terms of Service\n\nVersion 1. You agree to be nice.\n';
export const TOS_V1_1_TEXT = '# Terms of Service\n\nVersion 1.1. You agree to be nice. Typo fixed.\n';
export const TOS_V2_TEXT = '# Terms of Service\n\nVersion 2. Arbitration clause added.\n';
export const PRIVACY_V1_TEXT = '# Privacy Policy\n\nVersion 1. We keep very little.\n';

export const TOS_V1_SHA = sha256Hex(TOS_V1_TEXT);
export const TOS_V1_1_SHA = sha256Hex(TOS_V1_1_TEXT);
export const TOS_V2_SHA = sha256Hex(TOS_V2_TEXT);
export const PRIVACY_V1_SHA = sha256Hex(PRIVACY_V1_TEXT);

/** A corpus index in the shape `@ever-co/legal` emits, at ToS 1.0.0. */
export function corpusAtTosV1(): CorpusIndex {
	return {
		corpus: 'test',
		documents: [
			{
				document: 'tos',
				product: 'demo',
				productName: 'Demo',
				locale: 'en',
				version: '1.0.0',
				sha256: TOS_V1_SHA,
				effectiveDate: '2026-01-01',
				publishable: true,
			},
			{
				document: 'tos',
				product: 'demo',
				productName: 'Demo',
				locale: 'bg',
				version: '1.0.0',
				sha256: sha256Hex(`bg:${TOS_V1_TEXT}`),
				publishable: true,
			},
			{
				document: 'privacy',
				product: 'demo',
				productName: 'Demo',
				locale: 'en',
				version: '1.0.0',
				sha256: PRIVACY_V1_SHA,
				publishable: true,
			},
		],
	};
}

/** The same corpus after a MAJOR bump of the ToS, with a declared history. */
export function corpusAtTosV2(): CorpusIndex {
	const index = corpusAtTosV1();
	const tos = index.documents.find((d) => d.document === 'tos' && d.locale === 'en')!;
	tos.version = '2.0.0';
	tos.sha256 = TOS_V2_SHA;
	tos.effectiveDate = '2026-06-01';
	tos.history = [
		{ version: '1.0.0', material: true, sha256: TOS_V1_SHA, effectiveDate: '2026-01-01' },
		{ version: '1.1.0', material: false, sha256: TOS_V1_1_SHA, summary: 'Typo fixes.' },
		{ version: '2.0.0', material: true, sha256: TOS_V2_SHA, summary: 'Added an arbitration clause.' },
	];
	return index;
}

/** The same corpus after a MINOR bump only. */
export function corpusAtTosV1_1(): CorpusIndex {
	const index = corpusAtTosV1();
	const tos = index.documents.find((d) => d.document === 'tos' && d.locale === 'en')!;
	tos.version = '1.1.0';
	tos.sha256 = TOS_V1_1_SHA;
	tos.history = [
		{ version: '1.0.0', material: true, sha256: TOS_V1_SHA },
		{ version: '1.1.0', material: false, sha256: TOS_V1_1_SHA, summary: 'Typo fixes.' },
	];
	return index;
}

export const tosV1: RequiredDocument = {
	documentId: 'tos:demo',
	version: '1.0.0',
	sha256: TOS_V1_SHA,
	locale: 'en',
	title: 'Terms of Service',
};

export const IP_SALT = 'test-salt-at-least-16-chars';
