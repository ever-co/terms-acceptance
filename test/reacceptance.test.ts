import { describe, expect, it } from 'vitest';
import { MemoryAcceptanceAdapter } from '../src/adapters/memory.js';
import { selectRequiredDocuments } from '../src/corpus.js';
import { UndeclaredMaterialityError } from '../src/errors.js';
import { evaluateAcceptance } from '../src/evaluate.js';
import { decideMateriality } from '../src/materiality.js';
import { TermsAcceptanceService } from '../src/service.js';
import {
	TOS_V1_1_SHA,
	TOS_V1_SHA,
	TOS_V2_SHA,
	corpusAtTosV1,
	corpusAtTosV1_1,
	corpusAtTosV2,
} from './fixtures.js';

/** Accept everything the corpus currently requires, then move the corpus forward. */
async function signedUpAtV1() {
	const adapter = new MemoryAcceptanceAdapter();
	const service = new TermsAcceptanceService({ adapter, corpus: corpusAtTosV1() });
	const requiredThen = selectRequiredDocuments(corpusAtTosV1(), { product: 'demo' });
	await service.recordMany(requiredThen, { subjectId: 'user_1', method: 'signup-checkbox' });
	return { adapter, service };
}

describe('re-acceptance', () => {
	it('a MAJOR bump blocks the user at next login', async () => {
		const { adapter } = await signedUpAtV1();
		const service = new TermsAcceptanceService({ adapter, corpus: corpusAtTosV2() });
		const requiredNow = selectRequiredDocuments(corpusAtTosV2(), { product: 'demo' });

		const status = await service.status('user_1', requiredNow);

		expect(status.satisfied).toBe(false);
		expect(status.blocking).toHaveLength(1);
		expect(status.blocking[0]!.documentId).toBe('tos:demo');
		expect(status.blocking[0]!.reason).toBe('material-change');
		expect(status.blocking[0]!.acceptedVersion).toBe('1.0.0');
		expect(status.blocking[0]!.requiredVersion).toBe('2.0.0');
		expect(status.blocking[0]!.requiredSha256).toBe(TOS_V2_SHA);
		// Privacy did not move, so it must not be dragged into the modal.
		expect(status.current).toContain('privacy:demo');
		// The corpus's own summaries are handed to the modal.
		expect(status.blocking[0]!.changes.map((c) => c.version)).toEqual(['1.1.0', '2.0.0']);
	});

	it('a MINOR bump does not block — it is a notice', async () => {
		const { adapter } = await signedUpAtV1();
		const service = new TermsAcceptanceService({ adapter, corpus: corpusAtTosV1_1() });
		const requiredNow = selectRequiredDocuments(corpusAtTosV1_1(), { product: 'demo' });

		const status = await service.status('user_1', requiredNow);

		expect(status.satisfied).toBe(true);
		expect(status.blocking).toHaveLength(0);
		expect(status.notices).toHaveLength(1);
		expect(status.notices[0]!.documentId).toBe('tos:demo');
		expect(status.notices[0]!.reason).toBe('minor-change');
		expect(status.notices[0]!.requiredSha256).toBe(TOS_V1_1_SHA);
	});

	it('a PATCH bump does not block either', () => {
		const status = evaluateAcceptance(
			[{ documentId: 'tos:demo', version: '1.0.1', sha256: TOS_V1_1_SHA, locale: 'en' }],
			[acceptance('1.0.0', TOS_V1_SHA)]
		);
		expect(status.satisfied).toBe(true);
		expect(status.notices[0]!.reason).toBe('minor-change');
	});

	it('accepting again clears the block', async () => {
		const { adapter } = await signedUpAtV1();
		const service = new TermsAcceptanceService({ adapter, corpus: corpusAtTosV2() });
		const requiredNow = selectRequiredDocuments(corpusAtTosV2(), { product: 'demo' });

		const before = await service.status('user_1', requiredNow);
		await service.recordMany(
			requiredNow.filter((d) => before.blocking.some((b) => b.documentId === d.documentId)),
			{ subjectId: 'user_1', method: 'reaccept-modal' }
		);
		const after = await service.status('user_1', requiredNow);

		expect(after.satisfied).toBe(true);
		// Both events survive: the original signup and the re-acceptance, each with
		// its own method. That history is the audit trail.
		const history = await service.history({ subjectId: 'user_1', documentIds: ['tos:demo'] });
		expect(history.map((r) => `${r.version}/${r.method}`)).toEqual([
			'2.0.0/reaccept-modal',
			'1.0.0/signup-checkbox',
		]);
	});

	it('a user who never accepted is blocked with reason never-accepted', () => {
		const status = evaluateAcceptance(
			[{ documentId: 'tos:demo', version: '1.0.0', sha256: TOS_V1_SHA, locale: 'en' }],
			[]
		);
		expect(status.blocking[0]!.reason).toBe('never-accepted');
		expect(status.blocking[0]!.acceptedVersion).toBeNull();
	});

	it('same version but different text blocks by default', () => {
		const status = evaluateAcceptance(
			[{ documentId: 'tos:demo', version: '1.0.0', sha256: TOS_V2_SHA, locale: 'en' }],
			[acceptance('1.0.0', TOS_V1_SHA)]
		);
		expect(status.blocking[0]!.reason).toBe('text-mismatch');
	});

	it('never re-prompts a user who is ahead of the corpus', () => {
		const status = evaluateAcceptance(
			[{ documentId: 'tos:demo', version: '1.0.0', sha256: TOS_V1_SHA, locale: 'en' }],
			[acceptance('2.0.0', TOS_V2_SHA)]
		);
		expect(status.satisfied).toBe(true);
		expect(status.current).toEqual(['tos:demo']);
	});
});

describe('materiality is declared, not guessed', () => {
	const history = corpusAtTosV2().documents.find((d) => d.document === 'tos' && d.locale === 'en')!.history!;

	it('a declared material:false minor is not material even across a major line', () => {
		expect(decideMateriality('tos:demo', '1.0.0', '1.1.0', history).material).toBe(false);
		expect(decideMateriality('tos:demo', '1.0.0', '1.1.0', history).source).toBe('declared');
	});

	it('a declared material:true version is material even without a major bump', () => {
		const declared = [
			{ version: '1.0.0', material: true },
			{ version: '1.1.0', material: true, summary: 'New data recipient added.' },
		];
		const verdict = decideMateriality('privacy:demo', '1.0.0', '1.1.0', declared);
		expect(verdict.material).toBe(true);
		expect(verdict.source).toBe('declared');
	});

	it('falls back to "MAJOR is material" only when nothing is declared', () => {
		expect(decideMateriality('tos:demo', '1.0.0', '2.0.0', undefined).source).toBe('semver');
		expect(decideMateriality('tos:demo', '1.0.0', '2.0.0', undefined).material).toBe(true);
		expect(decideMateriality('tos:demo', '1.0.0', '1.4.2', undefined).material).toBe(false);
	});

	it("policy 'declared' refuses to guess", () => {
		expect(() => decideMateriality('tos:demo', '1.0.0', '2.0.0', undefined, 'declared')).toThrow(
			UndeclaredMaterialityError
		);
	});

	it('an unchanged version is never material', () => {
		expect(decideMateriality('tos:demo', '2.0.0', '2.0.0', history).source).toBe('unchanged');
	});
});

function acceptance(version: string, sha256: string) {
	return {
		id: `id-${version}`,
		subjectId: 'user_1',
		tenantId: null,
		documentId: 'tos:demo',
		version,
		sha256,
		acceptedAt: '2026-01-01T00:00:00.000Z',
		locale: 'en',
		ipHash: null,
		userAgent: null,
		method: 'signup-checkbox',
		metadata: null,
		fingerprint: 'unused-in-pure-evaluation',
	};
}
