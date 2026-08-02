/**
 * A dependency-free, synchronous SHA-256.
 *
 * Deliberately not `node:crypto`: this package is imported from Node servers,
 * edge runtimes, browsers (the React bits) and React Native (the Firebase
 * adapter). WebCrypto is async and not universally present; a 90-line hash that
 * runs identically everywhere is worth more here than raw speed. The inputs are
 * short strings — a document digest is computed by the corpus build, not here.
 */

const K = /* @__PURE__ */ new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
	0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
	0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
	0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
	0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** UTF-8 encode without depending on `TextEncoder` being global-typed. */
function utf8Bytes(str: string): Uint8Array {
	if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
	/* istanbul ignore next — only reached on exotic runtimes */
	const out: number[] = [];
	for (let i = 0; i < str.length; i++) {
		let c = str.charCodeAt(i);
		if (c < 0x80) out.push(c);
		else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
			const next = str.charCodeAt(++i);
			c = 0x10000 + ((c & 0x3ff) << 10) + (next & 0x3ff);
			out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
		} else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
	}
	return new Uint8Array(out);
}

/** Lowercase hex SHA-256 of a string or byte array. */
export function sha256Hex(input: string | Uint8Array): string {
	const msg = typeof input === 'string' ? utf8Bytes(input) : input;
	const bitLen = msg.length * 8;
	const padded = new Uint8Array((((msg.length + 8) >> 6) + 1) << 6);
	padded.set(msg);
	padded[msg.length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(padded.length - 4, bitLen >>> 0, false);
	view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);

	const h = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	]);
	const w = new Uint32Array(64);

	for (let off = 0; off < padded.length; off += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
		for (let i = 16; i < 64; i++) {
			const a = w[i - 15]!;
			const b = w[i - 2]!;
			const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
			const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
			w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
		}
		let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
		for (let i = 0; i < 64; i++) {
			const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
			const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (S0 + maj) >>> 0;
			hh = g;
			g = f;
			f = e;
			e = (d + t1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) >>> 0;
		}
		h[0] = (h[0]! + a) >>> 0;
		h[1] = (h[1]! + b) >>> 0;
		h[2] = (h[2]! + c) >>> 0;
		h[3] = (h[3]! + d) >>> 0;
		h[4] = (h[4]! + e) >>> 0;
		h[5] = (h[5]! + f) >>> 0;
		h[6] = (h[6]! + g) >>> 0;
		h[7] = (h[7]! + hh) >>> 0;
	}

	let hex = '';
	for (let i = 0; i < 8; i++) hex += h[i]!.toString(16).padStart(8, '0');
	return hex;
}

/** `true` for a lowercase 64-char hex digest. */
export function isSha256Hex(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Hash a client IP for storage.
 *
 * Storing raw IPs turns an audit trail into a tracking database. A salted digest
 * still lets you show "this acceptance came from a different address than that
 * one" without retaining the address itself. The salt must be a per-deployment
 * secret — an unsalted IP hash is trivially reversed (there are only 2^32 of them).
 */
export function hashIp(ip: string | null | undefined, salt: string): string | null {
	if (ip == null || ip === '') return null;
	if (!salt || salt.length < 16) {
		throw new Error('hashIp: salt must be a per-deployment secret of at least 16 characters');
	}
	return sha256Hex(`terms-acceptance:v1:${salt}:${ip.trim()}`);
}

/**
 * Deterministic JSON: keys sorted, `undefined` dropped, no whitespace.
 * Two records with the same content always produce the same string, on any engine.
 */
export function canonicalJson(value: unknown): string {
	if (value === null) return 'null';
	const t = typeof value;
	if (t === 'number') return Number.isFinite(value as number) ? JSON.stringify(value) : 'null';
	if (t === 'boolean' || t === 'string') return JSON.stringify(value);
	if (t === 'undefined' || t === 'function' || t === 'symbol') return 'null';
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (value instanceof Date) return JSON.stringify(value.toISOString());
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj)
		.filter((k) => obj[k] !== undefined)
		.sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}
