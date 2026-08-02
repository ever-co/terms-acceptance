/**
 * TypeORM / NestJS adapter — for services that own their own JWT and their own
 * user table (Ever Gauzy, Ever Traduora).
 *
 * There is no `import 'typeorm'` anywhere in this file, and that is deliberate: the
 * entity is expressed as an `EntitySchema` *options object* (plain data) and the
 * migration as a structurally-compatible class. A consumer on TypeORM 0.3 and a
 * consumer on 0.2 can both use this, and installing `terms-acceptance` never drags
 * TypeORM into a project that does not have it.
 *
 * ```ts
 * import { EntitySchema } from 'typeorm';
 * import { termsAcceptanceEntitySchema, TypeOrmAcceptanceAdapter } from 'terms-acceptance/typeorm';
 *
 * export const TermsAcceptance = new EntitySchema(termsAcceptanceEntitySchema);
 * ```
 */

import { DuplicateAcceptanceError, ImmutableRecordError } from '../../errors.js';
import { freezeRecord } from '../../record.js';
import type { AcceptanceQuery, AcceptanceRecord, AcceptanceStorageAdapter } from '../../types.js';
import { createTableSql, dropTableSql, isUniqueViolation } from '../sql.js';

/** The row as TypeORM sees it (camelCase properties, snake_case columns). */
export interface TermsAcceptanceEntity {
	id: string;
	subjectId: string;
	tenantId: string | null;
	documentId: string;
	version: string;
	sha256: string;
	acceptedAt: Date | string;
	locale: string;
	ipHash: string | null;
	userAgent: string | null;
	method: string;
	metadata: Record<string, unknown> | null;
	fingerprint: string;
}

/**
 * `EntitySchema` options. Pass straight to `new EntitySchema(...)`.
 *
 * Note there is no `@UpdateDateColumn` and no `version` column in the TypeORM
 * sense: the row is written once and never updated, so there is nothing to track.
 */
export const termsAcceptanceEntitySchema = {
	name: 'TermsAcceptance',
	tableName: 'terms_acceptance',
	columns: {
		id: { type: String, primary: true, length: 128 },
		subjectId: { type: String, name: 'subject_id', length: 255 },
		tenantId: { type: String, name: 'tenant_id', length: 255, nullable: true },
		documentId: { type: String, name: 'document_id', length: 255 },
		version: { type: String, length: 64 },
		sha256: { type: String, length: 64 },
		acceptedAt: { type: 'timestamptz', name: 'accepted_at' },
		locale: { type: String, length: 35 },
		ipHash: { type: String, name: 'ip_hash', length: 64, nullable: true },
		userAgent: { type: String, name: 'user_agent', length: 512, nullable: true },
		method: { type: String, length: 64 },
		metadata: { type: 'jsonb', nullable: true },
		fingerprint: { type: String, length: 64 },
	},
	indices: [
		{ name: 'terms_acceptance_unique_idx', unique: true, columns: ['subjectId', 'tenantId', 'documentId', 'version'] },
		{ name: 'terms_acceptance_subject_idx', unique: false, columns: ['subjectId', 'documentId', 'acceptedAt'] },
		{ name: 'terms_acceptance_document_idx', unique: false, columns: ['documentId', 'version'] },
	],
} as const;

/** The slice of `Repository<TermsAcceptanceEntity>` this adapter uses. */
export interface TermsAcceptanceRepositoryLike {
	insert(entity: TermsAcceptanceEntity): Promise<unknown>;
	find(options: {
		where: Record<string, unknown>;
		order?: Record<string, 'ASC' | 'DESC'>;
	}): Promise<TermsAcceptanceEntity[]>;
}

/** TypeORM `In(...)` operator, injected so we do not import TypeORM. */
export type InOperator = (values: readonly string[]) => unknown;

export interface TypeOrmAdapterOptions {
	repository: TermsAcceptanceRepositoryLike;
	/**
	 * TypeORM's `In` operator. Supply it to filter by `documentIds` in SQL; without
	 * it the adapter fetches the subject's rows and filters in memory, which is fine
	 * for the handful of documents a product has.
	 */
	In?: InOperator;
}

export class TypeOrmAcceptanceAdapter implements AcceptanceStorageAdapter {
	readonly name = 'typeorm';
	private readonly repo: TermsAcceptanceRepositoryLike;
	private readonly In: InOperator | undefined;

	constructor(options: TypeOrmAdapterOptions) {
		this.repo = options.repository;
		this.In = options.In;
	}

	async put(record: AcceptanceRecord): Promise<AcceptanceRecord> {
		try {
			await this.repo.insert({
				id: record.id,
				subjectId: record.subjectId,
				tenantId: record.tenantId ?? null,
				documentId: record.documentId,
				version: record.version,
				sha256: record.sha256,
				acceptedAt: new Date(record.acceptedAt),
				locale: record.locale,
				ipHash: record.ipHash,
				userAgent: record.userAgent,
				method: record.method,
				metadata: record.metadata ? { ...record.metadata } : null,
				fingerprint: record.fingerprint,
			});
		} catch (error) {
			const driver = (error as { driverError?: unknown }).driverError ?? error;
			if (isUniqueViolation(driver) || isUniqueViolation(error)) {
				throw new DuplicateAcceptanceError(record.subjectId, record.documentId, record.version);
			}
			throw error;
		}
		return freezeRecord({ ...record });
	}

	async list(query: AcceptanceQuery): Promise<AcceptanceRecord[]> {
		const where: Record<string, unknown> = { subjectId: query.subjectId };
		if (query.tenantId !== undefined) where['tenantId'] = query.tenantId;
		if (query.documentIds?.length && this.In) where['documentId'] = this.In(query.documentIds);

		const rows = await this.repo.find({ where, order: { acceptedAt: 'DESC' } });
		const filtered =
			query.documentIds?.length && !this.In
				? rows.filter((row) => query.documentIds!.includes(row.documentId))
				: rows;
		return filtered.map(entityToRecord);
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

export function entityToRecord(entity: TermsAcceptanceEntity): AcceptanceRecord {
	return freezeRecord({
		id: entity.id,
		subjectId: entity.subjectId,
		tenantId: entity.tenantId ?? null,
		documentId: entity.documentId,
		version: entity.version,
		sha256: entity.sha256,
		acceptedAt: entity.acceptedAt instanceof Date ? entity.acceptedAt.toISOString() : String(entity.acceptedAt),
		locale: entity.locale,
		ipHash: entity.ipHash ?? null,
		userAgent: entity.userAgent ?? null,
		method: entity.method,
		metadata: entity.metadata ?? null,
		fingerprint: entity.fingerprint,
	});
}

/* --------------------------------------------------------------- migration */

/** The `QueryRunner` surface a migration needs. */
export interface QueryRunnerLike {
	query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

/**
 * The migration, as raw SQL, so it can also be fed to Knex, Flyway, or `psql`.
 * `terms_acceptance` is created with the append-only trigger in place.
 */
export const migrationSql = {
	up: createTableSql({ table: 'terms_acceptance', indexPrefix: 'terms_acceptance', appendOnlyTrigger: true }),
	down: dropTableSql({ table: 'terms_acceptance', indexPrefix: 'terms_acceptance' }),
};

/**
 * A TypeORM migration class.
 *
 * Structurally implements `MigrationInterface`, so `typeorm migration:run` accepts
 * it without this package importing TypeORM. Register it in `migrations: [...]`.
 *
 * The `down()` drops the table. That is standard for a migration but note what it
 * means here: it destroys the evidence. In production, prefer to leave the table in
 * place and simply stop writing to it.
 */
export class CreateTermsAcceptance1754000000000 {
	name = 'CreateTermsAcceptance1754000000000';

	async up(queryRunner: QueryRunnerLike): Promise<void> {
		for (const statement of migrationSql.up) await queryRunner.query(statement);
	}

	async down(queryRunner: QueryRunnerLike): Promise<void> {
		for (const statement of migrationSql.down) await queryRunner.query(statement);
	}
}
