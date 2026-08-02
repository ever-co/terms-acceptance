/**
 * Optional React layer.
 *
 * `react` is a peer dependency with a wide range (`^18.2 || ^19`) because the fleet
 * spans React 18.2 to 19.2 and this package must not be the thing that forces an
 * upgrade. Nothing in the core imports React; importing `terms-acceptance` on a
 * server pulls none of this in.
 */

export { TermsCheckbox } from './TermsCheckbox.js';
export type { AcceptancePayload, TermsCheckboxProps } from './TermsCheckbox.js';

export { ReacceptModal } from './ReacceptModal.js';
export type { ReacceptModalProps } from './ReacceptModal.js';

export { useTermsGate } from './useTermsGate.js';
export type { TermsGate, UseTermsGateOptions } from './useTermsGate.js';

export type { AcceptanceStatus, PendingDocument, RequiredDocument } from '../types.js';
