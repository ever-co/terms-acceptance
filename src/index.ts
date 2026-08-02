/**
 * `terms-acceptance` — versioned, provable terms acceptance.
 *
 * The whole package exists to answer one question under oath: *did this person
 * agree to this exact text, and how do you know?* An {@link AcceptanceRecord} answers
 * it by pinning the acceptance to the sha256 of the document source as published by
 * a legal corpus, alongside when, in what language, from where (hashed), with what
 * client, and — the field people forget — by what mechanism.
 *
 * Entry points:
 *
 * - `terms-acceptance` — core: service, evaluation, corpus reading, hashing.
 * - `terms-acceptance/memory` — in-memory adapter (tests).
 * - `terms-acceptance/sql` — any SQL database via a `query(sql, params)` executor.
 * - `terms-acceptance/typeorm` — entity schema + migration (NestJS / own JWT).
 * - `terms-acceptance/better-auth` — plugin + model.
 * - `terms-acceptance/clerk` — webhook into our own table.
 * - `terms-acceptance/firebase` — Firestore via the Admin SDK.
 * - `terms-acceptance/react` — checkbox, re-accept modal, gate hook.
 */

export { TermsAcceptanceService, createTermsAcceptance } from './service.js';
export type { ServiceOptions } from './service.js';

export { evaluateAcceptance } from './evaluate.js';
export { decideMateriality, isMaterialChange, sortHistory } from './materiality.js';
export type { MaterialityVerdict } from './materiality.js';

export { assertPublishedText, documentIdOf, findDocument, selectRequiredDocuments } from './corpus.js';
export type { SelectOptions } from './corpus.js';

export { adoptRecord, assertIntact, buildRecord, fingerprintOf, freezeRecord, isIntact } from './record.js';

export { canonicalJson, hashIp, isSha256Hex, sha256Hex } from './hash.js';
export { compareVersions, isMajorBump, isNewer, majorOf, parseVersion } from './semver.js';
export type { ParsedVersion } from './semver.js';

export {
	DuplicateAcceptanceError,
	ImmutableRecordError,
	InvalidAcceptanceError,
	TamperedRecordError,
	TermsAcceptanceError,
	UndeclaredMaterialityError,
} from './errors.js';

export { MemoryAcceptanceAdapter } from './adapters/memory.js';

export type {
	AcceptanceInput,
	AcceptanceMethod,
	AcceptanceQuery,
	AcceptanceRecord,
	AcceptanceStatus,
	AcceptanceStorageAdapter,
	CorpusDocument,
	CorpusIndex,
	CorpusVersionEntry,
	EvaluateOptions,
	MaterialityPolicy,
	PendingDocument,
	PendingReason,
	RequiredDocument,
	SemVer,
} from './types.js';
