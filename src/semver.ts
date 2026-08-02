/**
 * The two semver operations this package needs, without pulling in `semver`.
 * Version strings come from the legal corpus, which controls them; we only need
 * to parse, compare, and read the major.
 */

export interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
	prerelease: string | null;
}

const RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse `1`, `1.2`, `1.2.3`, `v1.2.3`, `1.2.3-rc.1`. Returns `null` if unparseable. */
export function parseVersion(version: string): ParsedVersion | null {
	const m = RE.exec(String(version).trim());
	if (!m) return null;
	return {
		major: Number(m[1]),
		minor: m[2] === undefined ? 0 : Number(m[2]),
		patch: m[3] === undefined ? 0 : Number(m[3]),
		prerelease: m[4] ?? null,
	};
}

/** `-1 | 0 | 1`. Unparseable versions sort last but compare stably by string. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (!pa || !pb) return a === b ? 0 : a < b ? -1 : 1;
	if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
	if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
	if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
	// A release outranks its own pre-releases.
	if (pa.prerelease === pb.prerelease) return 0;
	if (pa.prerelease === null) return 1;
	if (pb.prerelease === null) return -1;
	return pa.prerelease < pb.prerelease ? -1 : 1;
}

/** `true` when `a` is strictly newer than `b`. */
export function isNewer(a: string, b: string): boolean {
	return compareVersions(a, b) === 1;
}

/** Major component, or `null` when the string is not a version. */
export function majorOf(version: string): number | null {
	return parseVersion(version)?.major ?? null;
}

/** `true` when `to` is a MAJOR bump relative to `from`. The built-in materiality heuristic. */
export function isMajorBump(from: string, to: string): boolean {
	const a = majorOf(from);
	const b = majorOf(to);
	if (a === null || b === null) return from !== to; // cannot reason → assume the worst
	return b > a;
}
