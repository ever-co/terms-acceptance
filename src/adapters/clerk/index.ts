/**
 * Clerk adapter — Cloc.
 *
 * Clerk owns the user, and Clerk's metadata is *not* an audit log: it is
 * last-write-wins, editable from the dashboard, editable from the browser in the
 * case of `unsafeMetadata`, not versioned, and not queryable in the way an auditor
 * needs ("show me everyone still on ToS 1.x"). So the metadata is used only as a
 * transport, and the evidence lands in a table we control.
 *
 * The flow:
 *
 * 1. the signup form calls {@link buildClerkAcceptanceMetadata} and passes the result
 *    as `unsafeMetadata` to `signUp.create(...)`;
 * 2. Clerk fires `user.created`;
 * 3. {@link createClerkWebhookHandler} verifies the signature, checks each claimed
 *    acceptance against the corpus, and writes a real record through the service.
 *
 * Step 3 is the one that matters: a value that arrived from the browser is a
 * *claim*, and it is only evidence once the server has checked it against the
 * published text and stored it somewhere the browser cannot reach.
 */

import type { TermsAcceptanceService } from '../../service.js';
import type { AcceptanceMethod, AcceptanceRecord, RequiredDocument } from '../../types.js';

export const CLERK_METADATA_KEY = 'termsAcceptance';

/** What the browser puts into `unsafeMetadata`. Treated as untrusted input. */
export interface ClerkAcceptanceClaim {
	documentId: string;
	version: string;
	sha256: string;
	locale: string;
	method: AcceptanceMethod;
	/** Client clock — recorded in metadata for reference, never used as `acceptedAt`. */
	clientAcceptedAt?: string;
}

/**
 * Build the `unsafeMetadata` payload for `signUp.create({ unsafeMetadata })`.
 *
 * ```ts
 * await signUp.create({
 *   emailAddress, password,
 *   unsafeMetadata: buildClerkAcceptanceMetadata(required, { method: 'signup-checkbox', locale: 'en' }),
 * });
 * ```
 */
export function buildClerkAcceptanceMetadata(
	documents: readonly RequiredDocument[],
	options: { method?: AcceptanceMethod; locale?: string; now?: () => Date } = {}
): Record<string, { acceptances: ClerkAcceptanceClaim[] }> {
	const now = (options.now ?? (() => new Date()))().toISOString();
	return {
		[CLERK_METADATA_KEY]: {
			acceptances: documents.map((doc) => ({
				documentId: doc.documentId,
				version: doc.version,
				sha256: doc.sha256,
				locale: options.locale ?? doc.locale,
				method: options.method ?? 'signup-checkbox',
				clientAcceptedAt: now,
			})),
		},
	};
}

/** The subset of a Clerk webhook event this handler reads. */
export interface ClerkWebhookEvent {
	type: string;
	data: {
		id?: string;
		unsafe_metadata?: Record<string, unknown>;
		public_metadata?: Record<string, unknown>;
		private_metadata?: Record<string, unknown>;
		created_at?: number;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

/**
 * Signature verification, injected.
 *
 * Wire it to Svix — Clerk's webhook signer — in the consumer, so this package does
 * not depend on `svix`:
 *
 * ```ts
 * import { Webhook } from 'svix';
 * const wh = new Webhook(process.env.CLERK_WEBHOOK_SECRET!);
 * const verify = (body: string, headers: Record<string, string>) =>
 *   wh.verify(body, headers) as ClerkWebhookEvent;
 * ```
 */
export type ClerkVerify = (
	rawBody: string,
	headers: Record<string, string>
) => ClerkWebhookEvent | Promise<ClerkWebhookEvent>;

export interface ClerkWebhookOptions {
	service: TermsAcceptanceService;
	/**
	 * The documents currently in force, from the corpus. A claim is only recorded if
	 * it matches one of these on `documentId` + `version` + `sha256` — that is what
	 * stops a hand-edited browser payload from minting fake evidence.
	 */
	required: RequiredDocument[] | (() => RequiredDocument[] | Promise<RequiredDocument[]>);
	/** Mandatory. Without verification anyone who can reach the URL can forge consent. */
	verify: ClerkVerify;
	/** Event types to act on. Default `['user.created', 'user.updated']`. */
	events?: string[];
	/** Called for claims that did not match the corpus. Default: throws. */
	onUnknownDocument?: (claim: ClerkAcceptanceClaim, event: ClerkWebhookEvent) => void;
	ipSalt?: string;
}

export interface ClerkWebhookResult {
	handled: boolean;
	eventType: string;
	subjectId: string | null;
	recorded: AcceptanceRecord[];
	skipped: ClerkAcceptanceClaim[];
}

/**
 * A framework-agnostic Clerk webhook handler.
 *
 * Give it the raw body (not a parsed object — Svix verifies the exact bytes) and the
 * request headers. Mount it under a Next.js route handler, an Express route, a
 * Cloudflare Worker, whatever.
 */
export function createClerkWebhookHandler(options: ClerkWebhookOptions) {
	const events = options.events ?? ['user.created', 'user.updated'];
	const resolveRequired = async (): Promise<RequiredDocument[]> =>
		typeof options.required === 'function' ? await options.required() : options.required;

	return async function handleClerkWebhook(
		rawBody: string,
		headers: Record<string, string>
	): Promise<ClerkWebhookResult> {
		const event = await options.verify(rawBody, lowercaseKeys(headers));

		if (!events.includes(event.type)) {
			return { handled: false, eventType: event.type, subjectId: null, recorded: [], skipped: [] };
		}

		const subjectId = typeof event.data.id === 'string' ? event.data.id : null;
		const claims = extractClaims(event);
		if (!subjectId || claims.length === 0) {
			return { handled: true, eventType: event.type, subjectId, recorded: [], skipped: claims };
		}

		const required = await resolveRequired();
		const recorded: AcceptanceRecord[] = [];
		const skipped: ClerkAcceptanceClaim[] = [];

		for (const claim of claims) {
			const match = required.find(
				(doc) => doc.documentId === claim.documentId && doc.version === claim.version && doc.sha256 === claim.sha256
			);
			if (!match) {
				if (options.onUnknownDocument) {
					options.onUnknownDocument(claim, event);
					skipped.push(claim);
					continue;
				}
				throw new Error(
					`terms-acceptance (clerk): claimed acceptance of ${claim.documentId}@${claim.version} ` +
						`does not match any published document. Refusing to record it.`
				);
			}

			recorded.push(
				await options.service.record({
					subjectId,
					documentId: match.documentId,
					version: match.version,
					sha256: match.sha256,
					locale: claim.locale || match.locale,
					method: claim.method || 'signup-checkbox',
					userAgent: headers['user-agent'] ?? null,
					ipHash: options.ipSalt ? options.service.hashIp(headers['x-forwarded-for']?.split(',')[0]?.trim()) : null,
					metadata: {
						source: 'clerk-webhook',
						clerkEvent: event.type,
						...(claim.clientAcceptedAt ? { clientAcceptedAt: claim.clientAcceptedAt } : {}),
					},
				})
			);
		}

		return { handled: true, eventType: event.type, subjectId, recorded, skipped };
	};
}

/** Pull acceptance claims out of any of Clerk's three metadata buckets. */
export function extractClaims(event: ClerkWebhookEvent): ClerkAcceptanceClaim[] {
	const buckets = [event.data.unsafe_metadata, event.data.public_metadata, event.data.private_metadata];
	for (const bucket of buckets) {
		const node = bucket?.[CLERK_METADATA_KEY] as { acceptances?: unknown } | undefined;
		if (node && Array.isArray(node.acceptances)) {
			return node.acceptances.filter(isClaim);
		}
	}
	return [];
}

function isClaim(value: unknown): value is ClerkAcceptanceClaim {
	const c = value as ClerkAcceptanceClaim | null;
	return (
		!!c &&
		typeof c.documentId === 'string' &&
		typeof c.version === 'string' &&
		typeof c.sha256 === 'string' &&
		typeof c.locale === 'string'
	);
}

function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
	return out;
}
