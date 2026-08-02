/**
 * A generic SQL adapter over any executor that can run a parameterised query.
 *
 * It has no driver dependency: pass anything with `query(sql, params)` that
 * resolves to `{ rows }` — `pg.Pool`, `pg.Client`, a Drizzle/Kysely raw executor,
 * a TypeORM `DataSource.query` wrapper, or a hand-rolled shim. The Better Auth and
 * Clerk adapters both build on this, because both of those systems keep their own
 * user store but neither gives you an audit table you can query.
 */

import { DuplicateAcceptanceError, ImmutableRecordError } from '../errors.js';
import { freezeRecord } from '../record.js';
import type { AcceptanceQuery, AcceptanceRecord, AcceptanceStorageAdapter } from '../types.js';

/** Minimal contract a driver must satisfy. `pg.Pool` already does. */
export interface SqlExecutor {
	query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface SqlAdapterOptions {
	executor: SqlExecutor;
	/** Default `terms_acceptance`. Validated — identifiers are never taken from user input. */
	table?: string;
	/** Default `public`. Pass `null` for engines without schemas. */
	schema?: string | null;
	/** `$n` for Postgres (default), `?` for MySQL/SQLite. */
	placeholder?: '$n' | '?';
	/** Emit a Postgres trigger that rejects UPDATE and DELETE. Default `true`. */
	appendOnlyTrigger?: boolean;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(value: string, what: string): string {
	if (!IDENT.test(value)) throw new Error(`terms-acceptance: unsafe ${what} identifier ${JSON.stringify(value)}`);
	return value;
}

const COLUMNS = [
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
] as const;

export class SqlAcceptanceAdapter implements AcceptanceStorageAdapter {
	readonly name = 'sql';
	private readonly exec: SqlExecutor;
	private readonly qualified: string;
	private readonly bare: string;
	private readonly style: '$n' | '?';
	private readonly trigger: boolean;

	constructor(options: SqlAdapterOptions) {
		this.exec = options.executor;
		this.bare = ident(options.table ?? 'terms_acceptance', 'table');
		const schema = options.schema === null ? null : ident(options.schema ?? 'public', 'schema');
		this.qualified = schema ? `${schema}.${this.bare}` : this.bare;
		this.style = options.placeholder ?? '$n';
		this.trigger = options.appendOnlyTrigger !== false;
	}

	private ph(n: number): string {
		return this.style === '?' ? '?' : `$${n}`;
	}

	private phList(count: number): string {
		return Array.from({ length: count }, (_, i) => this.ph(i + 1)).join(', ');
	}

	/** The DDL this adapter expects. Also exported standalone as {@link createTableSql}. */
	ddl(): string[] {
		return createTableSql({
			table: this.qualified,
			indexPrefix: this.bare,
			appendOnlyTrigger: this.trigger,
		});
	}

	async init(): Promise<void> {
		for (const statement of this.ddl()) await this.exec.query(statement);
	}

	async put(record: AcceptanceRecord): Promise<AcceptanceRecord> {
		const sql =
			`INSERT INTO ${this.qualified} (${COLUMNS.join(', ')}) ` +
			`VALUES (${this.phList(COLUMNS.length)})`;
		const params = [
			record.id,
			record.subjectId,
			record.tenantId ?? null,
			record.documentId,
			record.version,
			record.sha256,
			record.acceptedAt,
			record.locale,
			record.ipHash,
			record.userAgent,
			record.method,
			record.metadata == null ? null : JSON.stringify(record.metadata),
			record.fingerprint,
		];
		try {
			await this.exec.query(sql, params);
		} catch (error) {
			if (isUniqueViolation(error)) {
				throw new DuplicateAcceptanceError(record.subjectId, record.documentId, record.version);
			}
			throw error;
		}
		return freezeRecord({ ...record });
	}

	async list(query: AcceptanceQuery): Promise<AcceptanceRecord[]> {
		const params: unknown[] = [query.subjectId];
		let where = `subject_id = ${this.ph(1)}`;

		if (query.tenantId !== undefined) {
			if (query.tenantId === null) where += ` AND tenant_id IS NULL`;
			else {
				params.push(query.tenantId);
				where += ` AND tenant_id = ${this.ph(params.length)}`;
			}
		}
		if (query.documentIds?.length) {
			const slots = query.documentIds.map((id) => {
				params.push(id);
				return this.ph(params.length);
			});
			where += ` AND document_id IN (${slots.join(', ')})`;
		}

		const { rows } = await this.exec.query(
			`SELECT ${COLUMNS.join(', ')} FROM ${this.qualified} WHERE ${where} ORDER BY accepted_at DESC`,
			params
		);
		return rows.map(rowToRecord);
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

/** `true` for a Postgres/MySQL/SQLite unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
	const code = (error as { code?: string })?.code;
	if (code === '23505') return true; // Postgres
	if (code === 'ER_DUP_ENTRY' || code === '1062') return true; // MySQL
	if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) return true;
	const message = String((error as { message?: string })?.message ?? '');
	return /duplicate key|unique constraint|UNIQUE constraint failed/i.test(message);
}

/** Map a database row (snake_case) back onto a record. */
export function rowToRecord(row: Record<string, unknown>): AcceptanceRecord {
	const accepted = row['accepted_at'];
	const metadata = row['metadata'];
	return freezeRecord({
		id: String(row['id']),
		subjectId: String(row['subject_id']),
		tenantId: (row['tenant_id'] as string | null) ?? null,
		documentId: String(row['document_id']),
		version: String(row['version']),
		sha256: String(row['sha256']),
		acceptedAt: accepted instanceof Date ? accepted.toISOString() : String(accepted),
		locale: String(row['locale']),
		ipHash: (row['ip_hash'] as string | null) ?? null,
		userAgent: (row['user_agent'] as string | null) ?? null,
		method: String(row['method']),
		metadata:
			metadata == null ? null : typeof metadata === 'string' ? (JSON.parse(metadata) as Record<string, unknown>) : (metadata as Record<string, unknown>),
		fingerprint: String(row['fingerprint']),
	});
}

export interface DdlOptions {
	/** Fully-qualified table name, e.g. `public.terms_acceptance`. */
	table?: string;
	/** Prefix for index and trigger names. */
	indexPrefix?: string;
	appendOnlyTrigger?: boolean;
}

/**
 * Postgres DDL.
 *
 * Two details matter beyond the columns:
 *
 * 1. the unique index on `(subject_id, tenant_id, document_id, version)` makes a
 *    replayed submit a no-op instead of a second, contradictory record;
 * 2. the append-only trigger means the immutability promise is enforced by the
 *    database, not merely by this library. Application-level immutability is a
 *    convention; a trigger is a rule.
 */
export function createTableSql(options: DdlOptions = {}): string[] {
	const table = options.table ?? 'terms_acceptance';
	const prefix = options.indexPrefix ?? 'terms_acceptance';
	const statements = [
		`CREATE TABLE IF NOT EXISTS ${table} (
	id           varchar(128) PRIMARY KEY,
	subject_id   varchar(255) NOT NULL,
	tenant_id    varchar(255),
	document_id  varchar(255) NOT NULL,
	version      varchar(64)  NOT NULL,
	sha256       char(64)     NOT NULL,
	accepted_at  timestamptz  NOT NULL,
	locale       varchar(35)  NOT NULL,
	ip_hash      char(64),
	user_agent   varchar(512),
	method       varchar(64)  NOT NULL,
	metadata     jsonb,
	fingerprint  char(64)     NOT NULL
)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS ${prefix}_unique_idx
	ON ${table} (subject_id, coalesce(tenant_id, ''), document_id, version)`,
		`CREATE INDEX IF NOT EXISTS ${prefix}_subject_idx
	ON ${table} (subject_id, document_id, accepted_at DESC)`,
		`CREATE INDEX IF NOT EXISTS ${prefix}_document_idx
	ON ${table} (document_id, version)`,
	];

	if (options.appendOnlyTrigger !== false) {
		statements.push(
			`CREATE OR REPLACE FUNCTION ${prefix}_append_only() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'terms acceptance records are append-only: % is not permitted on %', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql`,
			`DROP TRIGGER IF EXISTS ${prefix}_append_only_trg ON ${table}`,
			`CREATE TRIGGER ${prefix}_append_only_trg
	BEFORE UPDATE OR DELETE ON ${table}
	FOR EACH ROW EXECUTE FUNCTION ${prefix}_append_only()`
		);
	}
	return statements;
}

/** The matching teardown, for a migration's `down()`. Drops nothing by default. */
export function dropTableSql(options: DdlOptions = {}): string[] {
	const table = options.table ?? 'terms_acceptance';
	const prefix = options.indexPrefix ?? 'terms_acceptance';
	// The trigger has to go first or the table cannot be dropped by the migration itself.
	return [
		`DROP TRIGGER IF EXISTS ${prefix}_append_only_trg ON ${table}`,
		`DROP FUNCTION IF EXISTS ${prefix}_append_only()`,
		`DROP TABLE IF EXISTS ${table}`,
	];
}
