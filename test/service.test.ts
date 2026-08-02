import { describe, expect, it } from 'vitest';
import { MemoryAcceptanceAdapter } from '../src/adapters/memory.js';
import { selectRequiredDocuments } from '../src/corpus.js';
import { sha256Hex } from '../src/hash.js';
import { TermsAcceptanceService } from '../src/service.js';
import { IP_SALT, PRIVACY_V1_SHA, TOS_V1_SHA, TOS_V1_TEXT, corpusAtTosV1, tosV1 } from './fixtures.js';

function makeService(corpus = corpusAtTosV1()) {
	const adapter = new MemoryAcceptanceAdapter();
	return { adapter, service: new TermsAcceptanceService({ adapter, corpus, ipSalt: IP_SALT }) };
}

describe('recording an acceptance', () => {
	it('writes the sha256 of the exact text that was published', async () => {
		const { service } = makeService();
		const required = selectRequiredDocuments(corpusAtTosV1(), { product: 'demo' });
		const tos = required.find((d) => d.documentId === 'tos:demo')!;

		const record = await service.record({
			subjectId: 'user_1',
			documentId: tos.documentId,
			version: tos.version,
			sha256: tos.sha256,
			locale: tos.locale,
			method: 'signup-checkbox',
		});

		// The digest in the record is the digest of the source markdown — recompute it
		// from the text and it still matches. That is the whole proof.
		expect(record.sha256).toBe(TOS_V1_SHA);
		expect(record.sha256).toBe(sha256Hex(TOS_V1_TEXT));
		expect(record.documentId).toBe('tos:demo');
		expect(record.version).toBe('1.0.0');
		expect(record.method).toBe('signup-checkbox');
	});

	it('records ToS and Privacy together at signup', async () => {
		const { service, adapter } = makeService();
		const required = selectRequiredDocuments(corpusAtTosV1(), { product: 'demo' });

		const records = await service.recordMany(required, {
			subjectId: 'user_1',
			method: 'signup-checkbox',
			ipHash: service.hashIp('203.0.113.7'),
			userAgent: 'Mozilla/5.0',
		});

		expect(records.map((r) => r.documentId).sort()).toEqual(['privacy:demo', 'tos:demo']);
		expect(records.map((r) => r.sha256).sort()).toEqual([PRIVACY_V1_SHA, TOS_V1_SHA].sort());
		expect(records.every((r) => r.ipHash !== null && r.ipHash!.length === 64)).toBe(true);
		expect(adapter.size).toBe(2);
	});

	it('refuses to record a sha256 the corpus never published', async () => {
		const { service } = makeService();
		await expect(
			service.record({
				subjectId: 'user_1',
				documentId: 'tos:demo',
				version: '1.0.0',
				sha256: sha256Hex('some text nobody ever saw'),
				locale: 'en',
				method: 'signup-checkbox',
			})
		).rejects.toThrow(/not in the corpus index/);
	});

	it('is idempotent — a double-submitted form yields one record, not two', async () => {
		const { service, adapter } = makeService();
		const first = await service.record({ subjectId: 'user_1', ...pick(tosV1), method: 'signup-checkbox' });
		const second = await service.record({ subjectId: 'user_1', ...pick(tosV1), method: 'signup-checkbox' });

		expect(adapter.size).toBe(1);
		expect(second.id).toBe(first.id);
		expect(second.acceptedAt).toBe(first.acceptedAt);
	});

	it('keeps separate records per subject and per tenant', async () => {
		const { service, adapter } = makeService();
		await service.record({ subjectId: 'user_1', ...pick(tosV1), method: 'signup-checkbox' });
		await service.record({ subjectId: 'user_2', ...pick(tosV1), method: 'signup-checkbox' });
		await service.record({ subjectId: 'user_1', tenantId: 'org_9', ...pick(tosV1), method: 'signup-checkbox' });
		expect(adapter.size).toBe(3);
	});

	it('honours an injected clock for back-dated imports', async () => {
		const adapter = new MemoryAcceptanceAdapter();
		const service = new TermsAcceptanceService({ adapter, now: () => new Date('2024-03-04T05:06:07.000Z') });
		const record = await service.record({ subjectId: 'user_1', ...pick(tosV1), method: 'import' });
		expect(record.acceptedAt).toBe('2024-03-04T05:06:07.000Z');
	});
});

describe('reading history', () => {
	it('returns newest first and verifies integrity', async () => {
		const adapter = new MemoryAcceptanceAdapter();
		const service = new TermsAcceptanceService({ adapter });
		await service.record({
			subjectId: 'u',
			...pick(tosV1),
			method: 'signup-checkbox',
			acceptedAt: '2026-01-01T00:00:00.000Z',
		});
		await service.record({
			subjectId: 'u',
			documentId: 'tos:demo',
			version: '2.0.0',
			sha256: TOS_V1_SHA,
			locale: 'en',
			method: 'reaccept-modal',
			acceptedAt: '2026-06-01T00:00:00.000Z',
		});
		const history = await service.history({ subjectId: 'u' });
		expect(history.map((r) => r.version)).toEqual(['2.0.0', '1.0.0']);
		expect(history.map((r) => r.method)).toEqual(['reaccept-modal', 'signup-checkbox']);
	});
});

function pick(doc: typeof tosV1) {
	return { documentId: doc.documentId, version: doc.version, sha256: doc.sha256, locale: doc.locale };
}
