import { describe, expect, it, vi } from 'vitest';
import { MemoryAcceptanceAdapter } from '../src/adapters/memory.js';
import { BetterAuthAcceptanceAdapter, clientIp, termsAcceptancePlugin } from '../src/adapters/better-auth/index.js';
import { buildClerkAcceptanceMetadata, createClerkWebhookHandler } from '../src/adapters/clerk/index.js';
import { FIRESTORE_RULES, FirebaseAcceptanceAdapter, acceptanceDocId } from '../src/adapters/firebase/index.js';
import { SqlAcceptanceAdapter, createTableSql, rowToRecord } from '../src/adapters/sql.js';
import {
	CreateTermsAcceptance1754000000000,
	TypeOrmAcceptanceAdapter,
	termsAcceptanceEntitySchema,
} from '../src/adapters/typeorm/index.js';
import { DuplicateAcceptanceError } from '../src/errors.js';
import { buildRecord } from '../src/record.js';
import { TermsAcceptanceService } from '../src/service.js';
import { TOS_V1_SHA, corpusAtTosV1, tosV1 } from './fixtures.js';

const base = {
	subjectId: 'user_1',
	documentId: 'tos:demo',
	version: '1.0.0',
	sha256: TOS_V1_SHA,
	locale: 'en',
	method: 'signup-checkbox' as const,
};

/* ------------------------------------------------------------------- SQL */

const SQL_COLUMNS = [
	'id',
	'subject_id',
	'tenant_id',
	'document_id',
	'version',
	'sha256',
	'accepted_at',
	'locale',
	'ip_hash',
	'user_agent',
	'method',
	'metadata',
	'fingerprint',
];

/** A fake `pg.Pool` that is just enough SQL to exercise the adapter. */
function fakePg() {
	const rows: Record<string, unknown>[] = [];
	const statements: string[] = [];
	return {
		rows,
		statements,
		async query(sql: string, params: readonly unknown[] = []) {
			statements.push(sql);
			if (/^INSERT/i.test(sql)) {
				const row: Record<string, unknown> = {};
				SQL_COLUMNS.forEach((column, index) => {
					row[column] = params[index] ?? null;
				});
				const clash = rows.some(
					(existing) =>
						existing['subject_id'] === row['subject_id'] &&
						(existing['tenant_id'] ?? null) === (row['tenant_id'] ?? null) &&
						existing['document_id'] === row['document_id'] &&
						existing['version'] === row['version']
				);
				if (clash) throw Object.assign(new Error('duplicate key value'), { code: '23505' });
				rows.push(row);
				return { rows: [] };
			}
			if (/^SELECT/i.test(sql)) {
				const subject = params[0];
				const documentIds = params.slice(1).filter((p) => typeof p === 'string' && p.includes(':'));
				return {
					rows: rows
						.filter((row) => row['subject_id'] === subject)
						.filter((row) => documentIds.length === 0 || documentIds.includes(row['document_id']))
						.sort((a, b) => String(b['accepted_at']).localeCompare(String(a['accepted_at']))),
				};
			}
			return { rows: [] };
		},
	};
}

describe('SQL adapter', () => {
	it('round-trips a record through insert and select', async () => {
		const executor = fakePg();
		const service = new TermsAcceptanceService({ adapter: new SqlAcceptanceAdapter({ executor }) });
		const written = await service.record(base);

		const read = await service.latest('user_1', 'tos:demo');
		expect(read).not.toBeNull();
		expect(read!.id).toBe(written.id);
		expect(read!.sha256).toBe(TOS_V1_SHA);
		expect(read!.fingerprint).toBe(written.fingerprint);
	});

	it('turns a unique-constraint violation into an idempotent replay', async () => {
		const executor = fakePg();
		const service = new TermsAcceptanceService({ adapter: new SqlAcceptanceAdapter({ executor }) });
		const first = await service.record(base);
		const second = await service.record(base);
		expect(second.id).toBe(first.id);
		expect(executor.rows).toHaveLength(1);
	});

	it('creates the table, the unique index and the append-only trigger', async () => {
		const executor = fakePg();
		await new SqlAcceptanceAdapter({ executor }).init();
		const ddl = executor.statements.join('\n');
		expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS public\.terms_acceptance/);
		expect(ddl).toMatch(/CREATE UNIQUE INDEX[\s\S]*subject_id, coalesce\(tenant_id, ''\), document_id, version/);
		expect(ddl).toMatch(/BEFORE UPDATE OR DELETE ON public\.terms_acceptance/);
		expect(ddl).toMatch(/append-only/);
	});

	it('refuses an unsafe table name rather than interpolating it', () => {
		expect(() => new SqlAcceptanceAdapter({ executor: fakePg(), table: 'x"; DROP TABLE users; --' })).toThrow(
			/unsafe table identifier/
		);
	});

	it('exposes update and delete only to reject them', () => {
		const adapter = new SqlAcceptanceAdapter({ executor: fakePg() });
		expect(() => adapter.update()).toThrow(/append-only/);
		expect(() => adapter.delete()).toThrow(/append-only/);
	});

	it('parses a metadata column stored as text or as jsonb', () => {
		const row = {
			id: 'a',
			subject_id: 'u',
			tenant_id: null,
			document_id: 'tos:demo',
			version: '1.0.0',
			sha256: TOS_V1_SHA,
			accepted_at: new Date('2026-01-01T00:00:00Z'),
			locale: 'en',
			ip_hash: null,
			user_agent: null,
			method: 'api',
			metadata: '{"a":1}',
			fingerprint: 'f',
		};
		expect(rowToRecord(row).metadata).toEqual({ a: 1 });
		expect(rowToRecord({ ...row, metadata: { a: 1 } }).metadata).toEqual({ a: 1 });
		expect(rowToRecord(row).acceptedAt).toBe('2026-01-01T00:00:00.000Z');
	});

	it('emits DDL usable without the adapter', () => {
		expect(createTableSql({ table: 'legal.acceptances', indexPrefix: 'acceptances' }).join('\n')).toContain(
			'legal.acceptances'
		);
	});
});

/* --------------------------------------------------------------- TypeORM */

describe('TypeORM adapter', () => {
	it('maps the entity to snake_case columns that match the SQL DDL', () => {
		const columns = termsAcceptanceEntitySchema.columns;
		expect(termsAcceptanceEntitySchema.tableName).toBe('terms_acceptance');
		expect(columns.subjectId.name).toBe('subject_id');
		expect(columns.ipHash.name).toBe('ip_hash');
		expect(columns.acceptedAt.type).toBe('timestamptz');
		const unique = termsAcceptanceEntitySchema.indices.find((i) => i.unique);
		expect(unique!.columns).toEqual(['subjectId', 'tenantId', 'documentId', 'version']);
	});

	it('inserts through a repository and reads back', async () => {
		const rows: Record<string, unknown>[] = [];
		const repository = {
			async insert(entity: Record<string, unknown>) {
				const clash = rows.some(
					(row) =>
						row['subjectId'] === entity['subjectId'] &&
						row['documentId'] === entity['documentId'] &&
						row['version'] === entity['version']
				);
				if (clash) throw { driverError: { code: '23505' }, message: 'duplicate key' };
				rows.push(entity);
			},
			async find() {
				return rows as never[];
			},
		};
		const service = new TermsAcceptanceService({
			adapter: new TypeOrmAcceptanceAdapter({ repository: repository as never }),
		});
		const written = await service.record(base);
		expect(rows[0]!['accepted_at' in rows[0]! ? 'accepted_at' : 'acceptedAt']).toBeInstanceOf(Date);

		const again = await service.record(base);
		expect(again.id).toBe(written.id);
		expect(rows).toHaveLength(1);
	});

	it('ships a migration that creates and drops the table', async () => {
		const executed: string[] = [];
		const queryRunner = {
			async query(sql: string) {
				executed.push(sql);
			},
		};
		const migration = new CreateTermsAcceptance1754000000000();
		await migration.up(queryRunner);
		expect(executed.join('\n')).toMatch(/CREATE TABLE IF NOT EXISTS terms_acceptance/);
		expect(executed.join('\n')).toMatch(/append_only_trg/);

		executed.length = 0;
		await migration.down(queryRunner);
		expect(executed.join('\n')).toMatch(/DROP TABLE IF EXISTS terms_acceptance/);
		// The trigger has to go before the table or the drop fails.
		expect(executed[0]).toMatch(/DROP TRIGGER/);
	});
});

/* ----------------------------------------------------------- Better Auth */

function fakeBetterAuthDb() {
	const rows: Record<string, unknown>[] = [];
	return {
		rows,
		async create({ data }: { model: string; data: Record<string, unknown> }) {
			rows.push(data);
			return data;
		},
		async findMany({ where }: { model: string; where?: { field: string; value: unknown }[] }) {
			return rows.filter((row) => (where ?? []).every((clause) => row[clause.field] === clause.value));
		},
	};
}

describe('Better Auth adapter', () => {
	it('declares a model the schema generator can create', () => {
		const plugin = termsAcceptancePlugin({ required: [tosV1] });
		expect(plugin.id).toBe('terms-acceptance');
		const model = (plugin.schema as Record<string, { fields: Record<string, unknown> }>)['termsAcceptance']!;
		expect(Object.keys(model.fields)).toEqual(
			expect.arrayContaining(['userId', 'documentId', 'version', 'sha256', 'acceptedAt', 'method', 'fingerprint'])
		);
		// Deleting a user must not cascade away the proof that they agreed.
		const userId = model.fields['userId'] as { references?: { onDelete?: string } };
		expect(userId.references).toEqual({ model: 'user', field: 'id' });
		expect(userId.references?.onDelete).toBeUndefined();
	});

	it('writes and reads through Better Auth’s own database layer', async () => {
		const database = fakeBetterAuthDb();
		const service = new TermsAcceptanceService({ adapter: new BetterAuthAcceptanceAdapter({ database }) });
		const written = await service.record(base);
		expect(database.rows[0]!['recordId']).toBe(written.id);
		expect(database.rows[0]!['userId']).toBe('user_1');

		const read = await service.latest('user_1', 'tos:demo');
		expect(read!.sha256).toBe(TOS_V1_SHA);
		expect(read!.id).toBe(written.id);
	});

	it('rejects a duplicate acceptance', async () => {
		const database = fakeBetterAuthDb();
		const adapter = new BetterAuthAcceptanceAdapter({ database });
		const record = buildRecord(base);
		await adapter.put(record);
		await expect(adapter.put(record)).rejects.toThrow(DuplicateAcceptanceError);
	});

	it('reads the client IP from the usual proxy headers', () => {
		expect(clientIp({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })).toBe('203.0.113.7');
		expect(clientIp({ 'cf-connecting-ip': '203.0.113.9' })).toBe('203.0.113.9');
		expect(clientIp({})).toBeNull();
	});
});

/* ----------------------------------------------------------------- Clerk */

describe('Clerk adapter', () => {
	const required = [tosV1];

	function makeHandler(overrides: Partial<Parameters<typeof createClerkWebhookHandler>[0]> = {}) {
		const service = new TermsAcceptanceService({
			adapter: new MemoryAcceptanceAdapter(),
		});
		return { service, handler: createClerkWebhookHandler({ service, required, verify: passthrough, ...overrides }) };
	}

	const passthrough = (raw: string) => JSON.parse(raw);

	it('records the acceptance carried on user.created', async () => {
		const { service, handler } = makeHandler();
		const metadata = buildClerkAcceptanceMetadata(required, { method: 'signup-checkbox', locale: 'en' });
		const event = {
			type: 'user.created',
			data: { id: 'user_clerk_1', unsafe_metadata: metadata },
		};

		const result = await handler(JSON.stringify(event), { 'user-agent': 'Mozilla/5.0' });

		expect(result.handled).toBe(true);
		expect(result.recorded).toHaveLength(1);
		expect(result.recorded[0]!.sha256).toBe(TOS_V1_SHA);
		expect(result.recorded[0]!.method).toBe('signup-checkbox');
		expect(result.recorded[0]!.metadata).toMatchObject({ source: 'clerk-webhook' });

		const stored = await service.latest('user_clerk_1', 'tos:demo');
		expect(stored).not.toBeNull();
	});

	it('refuses a claim whose sha256 was never published — the browser cannot mint evidence', async () => {
		const { handler } = makeHandler();
		const event = {
			type: 'user.created',
			data: {
				id: 'user_clerk_2',
				unsafe_metadata: {
					termsAcceptance: {
						acceptances: [{ documentId: 'tos:demo', version: '1.0.0', sha256: 'f'.repeat(64), locale: 'en' }],
					},
				},
			},
		};
		await expect(handler(JSON.stringify(event), {})).rejects.toThrow(/does not match any published document/);
	});

	it('ignores event types it was not asked to handle', async () => {
		const { handler } = makeHandler();
		const result = await handler(JSON.stringify({ type: 'session.created', data: { id: 'x' } }), {});
		expect(result.handled).toBe(false);
		expect(result.recorded).toHaveLength(0);
	});

	it('verifies the signature before doing anything', async () => {
		const verify = vi.fn(() => {
			throw new Error('bad signature');
		});
		const { handler } = makeHandler({ verify: verify as never });
		await expect(handler('{}', {})).rejects.toThrow('bad signature');
		expect(verify).toHaveBeenCalledOnce();
	});
});

/* -------------------------------------------------------------- Firebase */

function fakeFirestore() {
	const store = new Map<string, Record<string, unknown>>();
	const collection = (): ReturnType<typeof makeCollection> => makeCollection([]);

	function makeCollection(filters: Array<[string, string, unknown]>) {
		return {
			doc(id: string) {
				return {
					async create(data: Record<string, unknown>) {
						if (store.has(id)) throw Object.assign(new Error('already exists'), { code: 6 });
						store.set(id, data);
					},
					async get() {
						return { id, exists: store.has(id), data: () => store.get(id) };
					},
				};
			},
			where(field: string, op: string, value: unknown) {
				return makeCollection([...filters, [field, op, value]]);
			},
			orderBy() {
				return makeCollection(filters);
			},
			async get() {
				const docs = [...store.entries()]
					.filter(([, data]) =>
						filters.every(([field, op, value]) =>
							op === 'in' ? (value as unknown[]).includes(data[field]) : data[field] === value
						)
					)
					.map(([id, data]) => ({ id, data: () => data }));
				return { docs };
			},
		};
	}

	return { store, collection };
}

describe('Firebase adapter', () => {
	it('writes to Firestore and reads back', async () => {
		const firestore = fakeFirestore();
		const service = new TermsAcceptanceService({
			adapter: new FirebaseAcceptanceAdapter({ firestore: firestore as never }),
		});
		const written = await service.record({ ...base, subjectId: 'firebase_uid_1' });
		expect(firestore.store.size).toBe(1);

		const read = await service.latest('firebase_uid_1', 'tos:demo');
		expect(read!.id).toBe(written.id);
		expect(read!.sha256).toBe(TOS_V1_SHA);
	});

	it('derives a deterministic document id so a replay collides instead of duplicating', async () => {
		const firestore = fakeFirestore();
		const service = new TermsAcceptanceService({
			adapter: new FirebaseAcceptanceAdapter({ firestore: firestore as never }),
		});
		await service.record({ ...base, subjectId: 'firebase_uid_1' });
		await service.record({ ...base, subjectId: 'firebase_uid_1' });
		expect(firestore.store.size).toBe(1);

		expect(acceptanceDocId({ subjectId: 'a', documentId: 'tos:demo', version: '1.0.0' })).toBe(
			acceptanceDocId({ subjectId: 'a', tenantId: null, documentId: 'tos:demo', version: '1.0.0' })
		);
	});

	it('ships rules that deny update and delete', () => {
		expect(FIRESTORE_RULES).toMatch(/allow update: if false/);
		expect(FIRESTORE_RULES).toMatch(/allow delete: if false/);
		expect(FIRESTORE_RULES).toMatch(/allow create: if false/);
	});
});

/* ------------------------------------------------------------ corpus glue */

describe('corpus', () => {
	it('is the source of the sha256 an adapter ends up storing', async () => {
		const corpus = corpusAtTosV1();
		const service = new TermsAcceptanceService({
			adapter: new MemoryAcceptanceAdapter(),
			corpus,
		});
		const record = await service.record(base);
		const document = corpus.documents.find((d) => d.document === 'tos' && d.locale === 'en')!;
		expect(record.sha256).toBe(document.sha256);
	});
});
