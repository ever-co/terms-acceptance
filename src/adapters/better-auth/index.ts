/**
 * Better Auth adapter — Ever Works, Ever Hust, GitHands.
 *
 * Better Auth already owns a database and a schema generator, so the right shape
 * here is a plugin: declare a `termsAcceptance` model and let `better-auth migrate`
 * / `better-auth generate` create it alongside `user` and `session`. The adapter
 * then writes through Better Auth's own database layer, so it inherits whatever
 * driver, pooling and multi-tenancy the app already configured.
 *
 * Nothing from `better-auth` is imported. The plugin object is plain data, and the
 * two pieces that genuinely need the framework — `createAuthEndpoint` and
 * `sessionMiddleware` — are injected by the consumer:
 *
 * ```ts
 * import { betterAuth } from 'better-auth';
 * import { createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
 * import { termsAcceptancePlugin } from 'terms-acceptance/better-auth';
 *
 * export const auth = betterAuth({
 *   plugins: [termsAcceptancePlugin({ required, createAuthEndpoint, sessionMiddleware })],
 * });
 * ```
 */

import { DuplicateAcceptanceError, ImmutableRecordError } from '../../errors.js';
import { evaluateAcceptance } from '../../evaluate.js';
import { freezeRecord } from '../../record.js';
import { TermsAcceptanceService } from '../../service.js';
import type {
	AcceptanceQuery,
	AcceptanceRecord,
	AcceptanceStorageAdapter,
	EvaluateOptions,
	RequiredDocument,
} from '../../types.js';
import { isUniqueViolation } from '../sql.js';

/* ------------------------------------------------------------------ schema */

/**
 * The Better Auth model definition.
 *
 * `userId` references `user.id`. Note `onDelete: 'cascade'` is *not* set: deleting a
 * user should not silently destroy the proof that they once agreed to something. If
 * a jurisdiction requires erasure, delete the record deliberately, not as a side
 * effect of a foreign key.
 */
export const termsAcceptanceSchema = {
	termsAcceptance: {
		modelName: 'termsAcceptance',
		fields: {
			recordId: { type: 'string', required: true, unique: true },
			userId: { type: 'string', required: true, references: { model: 'user', field: 'id' } },
			tenantId: { type: 'string', required: false },
			documentId: { type: 'string', required: true },
			version: { type: 'string', required: true },
			sha256: { type: 'string', required: true },
			acceptedAt: { type: 'date', required: true },
			locale: { type: 'string', required: true },
			ipHash: { type: 'string', required: false },
			userAgent: { type: 'string', required: false },
			method: { type: 'string', required: true },
			metadata: { type: 'string', required: false },
			fingerprint: { type: 'string', required: true },
		},
	},
} as const;

/* ----------------------------------------------------------------- adapter */

/** One `where` clause in Better Auth's database layer. */
export interface BetterAuthWhere {
	field: string;
	value: unknown;
	operator?: 'eq' | 'in' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
	connector?: 'AND' | 'OR';
}

/** The slice of Better Auth's internal database adapter this adapter uses. */
export interface BetterAuthDatabase {
	create(input: { model: string; data: Record<string, unknown> }): Promise<Record<string, unknown>>;
	findMany(input: {
		model: string;
		where?: BetterAuthWhere[];
		sortBy?: { field: string; direction: 'asc' | 'desc' };
		limit?: number;
	}): Promise<Record<string, unknown>[]>;
}

export class BetterAuthAcceptanceAdapter implements AcceptanceStorageAdapter {
	readonly name = 'better-auth';
	private readonly db: BetterAuthDatabase;
	private readonly model: string;

	constructor(options: { database: BetterAuthDatabase; model?: string }) {
		this.db = options.database;
		this.model = options.model ?? 'termsAcceptance';
	}

	async put(record: AcceptanceRecord): Promise<AcceptanceRecord> {
		// Better Auth has no unique constraint on the natural key, so check first.
		const existing = await this.db.findMany({
			model: this.model,
			where: [
				{ field: 'userId', value: record.subjectId },
				{ field: 'documentId', value: record.documentId },
				{ field: 'version', value: record.version },
			],
			limit: 1,
		});
		if (existing.length > 0) {
			throw new DuplicateAcceptanceError(record.subjectId, record.documentId, record.version);
		}

		try {
			await this.db.create({
				model: this.model,
				data: {
					recordId: record.id,
					userId: record.subjectId,
					tenantId: record.tenantId ?? null,
					documentId: record.documentId,
					version: record.version,
					sha256: record.sha256,
					acceptedAt: new Date(record.acceptedAt),
					locale: record.locale,
					ipHash: record.ipHash,
					userAgent: record.userAgent,
					method: record.method,
					metadata: record.metadata ? JSON.stringify(record.metadata) : null,
					fingerprint: record.fingerprint,
				},
			});
		} catch (error) {
			if (isUniqueViolation(error)) {
				throw new DuplicateAcceptanceError(record.subjectId, record.documentId, record.version);
			}
			throw error;
		}
		return freezeRecord({ ...record });
	}

	async list(query: AcceptanceQuery): Promise<AcceptanceRecord[]> {
		const where: BetterAuthWhere[] = [{ field: 'userId', value: query.subjectId }];
		if (query.tenantId !== undefined && query.tenantId !== null) {
			where.push({ field: 'tenantId', value: query.tenantId });
		}
		const rows = await this.db.findMany({
			model: this.model,
			where,
			sortBy: { field: 'acceptedAt', direction: 'desc' },
		});
		return rows
			.map(rowToRecord)
			.filter((row) => !query.documentIds?.length || query.documentIds.includes(row.documentId))
			.filter((row) => query.tenantId === undefined || (row.tenantId ?? null) === (query.tenantId ?? null));
	}

	async latest(query: AcceptanceQuery & { documentId: string }): Promise<AcceptanceRecord | null> {
		const rows = await this.list({ ...query, documentIds: [query.documentId] });
		return rows[0] ?? null;
	}

	update(): never {
		throw new ImmutableRecordError('update');
	}

	delete(): never {
		throw new ImmutableRecordError('delete');
	}
}

function rowToRecord(row: Record<string, unknown>): AcceptanceRecord {
	const acceptedAt = row['acceptedAt'];
	const metadata = row['metadata'];
	return freezeRecord({
		id: String(row['recordId'] ?? row['id']),
		subjectId: String(row['userId']),
		tenantId: (row['tenantId'] as string | null) ?? null,
		documentId: String(row['documentId']),
		version: String(row['version']),
		sha256: String(row['sha256']),
		acceptedAt: acceptedAt instanceof Date ? acceptedAt.toISOString() : String(acceptedAt),
		locale: String(row['locale']),
		ipHash: (row['ipHash'] as string | null) ?? null,
		userAgent: (row['userAgent'] as string | null) ?? null,
		method: String(row['method']),
		metadata: typeof metadata === 'string' ? (JSON.parse(metadata) as Record<string, unknown>) : ((metadata as Record<string, unknown>) ?? null),
		fingerprint: String(row['fingerprint']),
	});
}

/* ------------------------------------------------------------------ plugin */

/** Loose shape of a Better Auth endpoint context. */
export interface BetterAuthEndpointContext {
	body?: Record<string, unknown>;
	headers?: Headers | Record<string, string | undefined>;
	context: {
		session?: { user?: { id?: string } } | null;
		adapter?: BetterAuthDatabase;
		[key: string]: unknown;
	};
	json?: (value: unknown) => unknown;
	[key: string]: unknown;
}

/** `createAuthEndpoint` from `better-auth/api`, injected. */
export type CreateAuthEndpoint = (
	path: string,
	options: Record<string, unknown>,
	handler: (ctx: BetterAuthEndpointContext) => Promise<unknown>
) => unknown;

export interface TermsAcceptancePluginOptions {
	/** Documents that gate access. Usually built with `selectRequiredDocuments(corpus, …)`. */
	required: RequiredDocument[] | (() => RequiredDocument[] | Promise<RequiredDocument[]>);
	/** `createAuthEndpoint` from `better-auth/api`. Omit to get schema + helpers only. */
	createAuthEndpoint?: CreateAuthEndpoint;
	/** `sessionMiddleware` from `better-auth/api`. Strongly recommended when adding endpoints. */
	sessionMiddleware?: unknown;
	/** Per-deployment secret for hashing client IPs. Omit to not record IPs at all. */
	ipSalt?: string;
	/** Override the model name if `termsAcceptance` collides. */
	model?: string;
	evaluate?: EvaluateOptions;
}

/**
 * Build the Better Auth plugin.
 *
 * Returns `{ id, schema }` always, and `endpoints` when `createAuthEndpoint` was
 * supplied:
 *
 * - `GET  /terms-acceptance/status` — what the signed-in user still owes.
 * - `POST /terms-acceptance/accept` — record acceptance for the outstanding documents.
 */
export function termsAcceptancePlugin(options: TermsAcceptancePluginOptions) {
	const model = options.model ?? 'termsAcceptance';
	const resolveRequired = async (): Promise<RequiredDocument[]> =>
		typeof options.required === 'function' ? await options.required() : options.required;

	const serviceFor = (database: BetterAuthDatabase): TermsAcceptanceService =>
		new TermsAcceptanceService({
			adapter: new BetterAuthAcceptanceAdapter({ database, model }),
			...(options.ipSalt ? { ipSalt: options.ipSalt } : {}),
			...(options.evaluate?.materiality ? { materiality: options.evaluate.materiality } : {}),
			...(options.evaluate?.onTextMismatch ? { onTextMismatch: options.evaluate.onTextMismatch } : {}),
		});

	const base = {
		id: 'terms-acceptance',
		schema: options.model
			? { [options.model]: { ...termsAcceptanceSchema.termsAcceptance, modelName: options.model } }
			: termsAcceptanceSchema,
	};

	if (!options.createAuthEndpoint) return base;

	const withSession = options.sessionMiddleware ? { use: [options.sessionMiddleware] } : {};

	const status = options.createAuthEndpoint('/terms-acceptance/status', { method: 'GET', ...withSession }, async (ctx) => {
		const userId = ctx.context.session?.user?.id;
		if (!userId) throw new Error('terms-acceptance: no session');
		const database = requireDatabase(ctx);
		const required = await resolveRequired();
		return serviceFor(database).status(userId, required, options.evaluate ?? {});
	});

	const accept = options.createAuthEndpoint(
		'/terms-acceptance/accept',
		{ method: 'POST', ...withSession },
		async (ctx) => {
			const userId = ctx.context.session?.user?.id;
			if (!userId) throw new Error('terms-acceptance: no session');
			const database = requireDatabase(ctx);
			const service = serviceFor(database);
			const required = await resolveRequired();

			const requestedIds = Array.isArray(ctx.body?.['documentIds'])
				? (ctx.body!['documentIds'] as string[])
				: undefined;
			const documents = requestedIds ? required.filter((d) => requestedIds.includes(d.documentId)) : required;

			const method = typeof ctx.body?.['method'] === 'string' ? (ctx.body!['method'] as string) : 'reaccept-modal';
			const headers = normaliseHeaders(ctx.headers);

			const records = await service.recordMany(documents, {
				subjectId: userId,
				method,
				ipHash: options.ipSalt ? service.hashIp(clientIp(headers)) : null,
				userAgent: headers['user-agent'] ?? null,
			});
			const after = evaluateAcceptance(required, records, options.evaluate ?? {});
			return { recorded: records.length, status: after };
		}
	);

	return { ...base, endpoints: { termsAcceptanceStatus: status, termsAcceptanceAccept: accept } };
}

function requireDatabase(ctx: BetterAuthEndpointContext): BetterAuthDatabase {
	const database = ctx.context.adapter;
	if (!database) throw new Error('terms-acceptance: Better Auth database adapter is not on the endpoint context');
	return database;
}

function normaliseHeaders(headers: BetterAuthEndpointContext['headers']): Record<string, string> {
	const out: Record<string, string> = {};
	if (!headers) return out;
	if (typeof (headers as Headers).forEach === 'function' && typeof (headers as Headers).get === 'function') {
		(headers as Headers).forEach((value, key) => {
			out[key.toLowerCase()] = value;
		});
		return out;
	}
	for (const [key, value] of Object.entries(headers as Record<string, string | undefined>)) {
		if (value !== undefined) out[key.toLowerCase()] = value;
	}
	return out;
}

/** First hop of `x-forwarded-for`, else `x-real-ip`. */
export function clientIp(headers: Record<string, string>): string | null {
	const forwarded = headers['x-forwarded-for'];
	if (forwarded) return forwarded.split(',')[0]!.trim();
	return headers['x-real-ip'] ?? headers['cf-connecting-ip'] ?? null;
}
