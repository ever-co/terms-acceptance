import { describe, expect, it } from 'vitest';
import { InvalidAcceptanceError, TamperedRecordError } from '../src/errors.js';
import { sha256Hex } from '../src/hash.js';
import { assertIntact, buildRecord, fingerprintOf, isIntact } from '../src/record.js';
import { MemoryAcceptanceAdapter } from '../src/adapters/memory.js';
import { TermsAcceptanceService } from '../src/service.js';
import { IP_SALT, TOS_V1_SHA, TOS_V1_TEXT } from './fixtures.js';

const input = {
	subjectId: 'user_1',
	documentId: 'tos:demo',
	version: '1.0.0',
	sha256: TOS_V1_SHA,
	locale: 'en',
	method: 'signup-checkbox' as const,
};

describe('buildRecord', () => {
	it('fills in id, acceptedAt and fingerprint', () => {
		const record = buildRecord(input);
		expect(record.id).toMatch(/^ta_/);
		expect(Date.parse(record.acceptedAt)).not.toBeNaN();
		expect(record.fingerprint).toBe(fingerprintOf(record));
		expect(isIntact(record)).toBe(true);
	});

	it('rejects anything that is not a real sha256', () => {
		expect(() => buildRecord({ ...input, sha256: 'nope' })).toThrow(InvalidAcceptanceError);
		expect(() => buildRecord({ ...input, sha256: TOS_V1_SHA.toUpperCase() })).toThrow(/sha256/);
	});

	it('rejects a raw IP in the ipHash field', () => {
		// The single most likely way to turn an audit table into a tracking database.
		expect(() => buildRecord({ ...input, ipHash: '203.0.113.7' })).toThrow(/ipHash/);
	});

	it('rejects an unparseable locale', () => {
		expect(() => buildRecord({ ...input, locale: 'english please' })).toThrow(/locale/);
	});

	it('requires a method — proving how consent was obtained is not optional', () => {
		expect(() => buildRecord({ ...input, method: '' })).toThrow(/method/);
	});
});

describe('the record is immutable', () => {
	it('throws on assignment to any field', () => {
		const record = buildRecord(input);
		expect(() => {
			(record as { version: string }).version = '9.9.9';
		}).toThrow(TypeError);
		expect(() => {
			(record as { acceptedAt: string }).acceptedAt = '2000-01-01T00:00:00.000Z';
		}).toThrow(TypeError);
		expect(record.version).toBe('1.0.0');
	});

	it('freezes nested metadata too', () => {
		const record = buildRecord({ ...input, metadata: { formId: 'signup-a' } });
		expect(Object.isFrozen(record.metadata)).toBe(true);
		expect(() => {
			(record.metadata as Record<string, unknown>)['formId'] = 'tampered';
		}).toThrow(TypeError);
	});

	it('detects a record edited in storage', () => {
		const record = buildRecord(input);
		const tampered = { ...record, acceptedAt: '2020-01-01T00:00:00.000Z' };
		expect(isIntact(tampered)).toBe(false);
		expect(() => assertIntact(tampered)).toThrow(TamperedRecordError);
	});

	it('refuses to hand back a tampered record on read', async () => {
		const adapter = new MemoryAcceptanceAdapter();
		const service = new TermsAcceptanceService({ adapter, ipSalt: IP_SALT });
		await service.record(input);

		// Simulate someone with database access rewriting the row.
		const stored = (await adapter.list({ subjectId: 'user_1' }))[0]!;
		const forged = { ...stored, version: '2.0.0' };
		const forgingAdapter = {
			...adapter,
			name: 'forged',
			put: adapter.put.bind(adapter),
			latest: adapter.latest.bind(adapter),
			list: async () => [forged],
		};
		const reader = new TermsAcceptanceService({ adapter: forgingAdapter });
		await expect(reader.history({ subjectId: 'user_1' })).rejects.toThrow(TamperedRecordError);
	});

	it('adapters expose no update or delete path', () => {
		const adapter = new MemoryAcceptanceAdapter();
		expect(() => adapter.update()).toThrow(/append-only/);
		expect(() => adapter.delete()).toThrow(/append-only/);
	});
});

describe('fingerprint', () => {
	it('changes when any covered field changes', () => {
		const record = buildRecord(input);
		for (const patch of [
			{ subjectId: 'user_2' },
			{ documentId: 'privacy:demo' },
			{ version: '1.0.1' },
			{ sha256: sha256Hex(TOS_V1_TEXT + ' ') },
			{ locale: 'bg' },
			{ method: 'admin-recorded' },
			{ userAgent: 'curl/8' },
			{ metadata: { a: 1 } },
		]) {
			expect(fingerprintOf({ ...record, ...patch })).not.toBe(record.fingerprint);
		}
	});
});
