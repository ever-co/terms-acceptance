import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, hashIp, isSha256Hex, sha256Hex } from '../src/hash.js';

describe('sha256Hex', () => {
	it('matches the published test vectors', () => {
		expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
		expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
		expect(sha256Hex('hello world')).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
	});

	it('agrees with node:crypto across lengths and multi-byte text', () => {
		// The corpus computes its digests with node:crypto; if these two ever
		// disagreed, every acceptance record in the fleet would point at nothing.
		const samples = [
			'a',
			'a'.repeat(55), // one block minus the length field
			'a'.repeat(56), // forces a second block
			'a'.repeat(64),
			'a'.repeat(1000),
			'Общи условия — версия 2',
			'契約条件 v2 🧾',
			'# Terms\n\nline\r\nline\ttab\n',
		];
		for (const sample of samples) {
			expect(sha256Hex(sample), sample.slice(0, 24)).toBe(createHash('sha256').update(sample, 'utf8').digest('hex'));
		}
	});

	it('recognises a well-formed digest', () => {
		expect(isSha256Hex(sha256Hex('x'))).toBe(true);
		expect(isSha256Hex(sha256Hex('x').toUpperCase())).toBe(false);
		expect(isSha256Hex('deadbeef')).toBe(false);
		expect(isSha256Hex(null)).toBe(false);
	});
});

describe('hashIp', () => {
	it('is deterministic, salted, and never returns the address', () => {
		const salt = 'salt-that-is-long-enough';
		const hashed = hashIp('203.0.113.7', salt);
		expect(hashed).toBe(hashIp('203.0.113.7', salt));
		expect(hashed).not.toBe(hashIp('203.0.113.7', 'a-completely-different-salt'));
		expect(hashed).not.toContain('203');
		expect(isSha256Hex(hashed!)).toBe(true);
	});

	it('refuses a weak salt — an unsalted IP hash is reversible in seconds', () => {
		expect(() => hashIp('203.0.113.7', 'short')).toThrow(/salt/);
	});

	it('passes null through', () => {
		expect(hashIp(null, 'salt-that-is-long-enough')).toBeNull();
		expect(hashIp(undefined, 'salt-that-is-long-enough')).toBeNull();
	});
});

describe('canonicalJson', () => {
	it('is stable regardless of key order', () => {
		expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
	});

	it('drops undefined but keeps null', () => {
		expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
	});

	it('preserves array order', () => {
		expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
	});
});
