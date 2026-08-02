import { describe, expect, it } from 'vitest';
import { assertPublishedText, documentIdOf, findDocument, selectRequiredDocuments } from '../src/corpus.js';
import { compareVersions, isMajorBump, parseVersion } from '../src/semver.js';
import { PRIVACY_V1_SHA, TOS_V1_SHA, corpusAtTosV1, corpusAtTosV2 } from './fixtures.js';

describe('selectRequiredDocuments', () => {
	it('defaults to ToS + Privacy for the product', () => {
		const required = selectRequiredDocuments(corpusAtTosV1(), { product: 'demo' });
		expect(required.map((d) => d.documentId)).toEqual(['tos:demo', 'privacy:demo']);
		expect(required[0]!.sha256).toBe(TOS_V1_SHA);
		expect(required[1]!.sha256).toBe(PRIVACY_V1_SHA);
		expect(required[0]!.title).toBe('Terms of Service');
	});

	it('serves the requested locale and pins its own digest', () => {
		const bg = selectRequiredDocuments(corpusAtTosV1(), { product: 'demo', locale: 'bg', documents: ['tos'] });
		expect(bg[0]!.locale).toBe('bg');
		expect(bg[0]!.sha256).not.toBe(TOS_V1_SHA);
	});

	it('falls back to English when the locale is missing, and says so in the record', () => {
		const fr = selectRequiredDocuments(corpusAtTosV1(), { product: 'demo', locale: 'fr-CA', documents: ['tos'] });
		expect(fr[0]!.locale).toBe('en');
	});

	it('carries the declared history through to the evaluator', () => {
		const required = selectRequiredDocuments(corpusAtTosV2(), { product: 'demo', documents: ['tos'] });
		expect(required[0]!.history?.map((h) => h.version)).toEqual(['1.0.0', '1.1.0', '2.0.0']);
	});

	it('builds URLs when asked', () => {
		const required = selectRequiredDocuments(corpusAtTosV1(), {
			product: 'demo',
			documents: ['tos'],
			url: (doc) => `https://demo.example/${doc.document}`,
		});
		expect(required[0]!.url).toBe('https://demo.example/tos');
	});

	it('skips documents the corpus has not marked publishable', () => {
		const index = corpusAtTosV1();
		index.documents.forEach((d) => {
			d.publishable = false;
		});
		expect(selectRequiredDocuments(index, { product: 'demo' })).toHaveLength(0);
	});
});

describe('assertPublishedText', () => {
	it('accepts the current version', () => {
		expect(() => assertPublishedText(corpusAtTosV1(), 'tos:demo', '1.0.0', TOS_V1_SHA)).not.toThrow();
	});

	it('accepts a historical version still declared in the corpus', () => {
		expect(() => assertPublishedText(corpusAtTosV2(), 'tos:demo', '1.0.0', TOS_V1_SHA)).not.toThrow();
	});

	it('rejects a digest nobody published', () => {
		expect(() => assertPublishedText(corpusAtTosV1(), 'tos:demo', '1.0.0', 'a'.repeat(64))).toThrow(
			/not in the corpus index/
		);
	});
});

describe('helpers', () => {
	it('composes and finds document ids', () => {
		expect(documentIdOf({ document: 'tos', product: 'gauzy' })).toBe('tos:gauzy');
		expect(findDocument(corpusAtTosV1(), 'tos:demo', 'bg')!.locale).toBe('bg');
		expect(findDocument(corpusAtTosV1(), 'nope:demo')).toBeNull();
	});

	it('parses and orders versions', () => {
		expect(parseVersion('v2.3.4-rc.1')).toEqual({ major: 2, minor: 3, patch: 4, prerelease: 'rc.1' });
		expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
		expect(compareVersions('2.0.0-rc.1', '2.0.0')).toBe(-1);
		expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
		expect(isMajorBump('1.4.0', '2.0.0')).toBe(true);
		expect(isMajorBump('1.4.0', '1.5.0')).toBe(false);
		// Unparseable versions are treated as "we cannot reason about this" → material.
		expect(isMajorBump('spring-2026', 'summer-2026')).toBe(true);
	});
});
