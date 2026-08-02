import { useCallback, useMemo, useState } from 'react';
import type { AcceptanceMethod, RequiredDocument } from '../types.js';

/**
 * Exactly what has to reach the server for the acceptance to be provable.
 *
 * This type exists to make the fleet's actual bug hard to write. Three products
 * render a checkbox, use it to enable the submit button, and then send a signup
 * request that never mentions it — the appearance of consent with none of the
 * evidence. Here the checkbox hands you a payload, and the payload is the thing you
 * post. If you throw it away, you have visibly thrown something away.
 */
export interface AcceptancePayload {
	accepted: true;
	method: AcceptanceMethod;
	locale: string;
	/** Client clock. The server timestamps the record itself; this is context only. */
	clientAcceptedAt: string;
	documents: Array<{
		documentId: string;
		version: string;
		sha256: string;
		locale: string;
	}>;
}

export interface TermsCheckboxProps {
	/** The documents this checkbox covers, from the corpus. */
	documents: readonly RequiredDocument[];
	/**
	 * Fired on every change. `payload` is `null` when unchecked, and the object you
	 * must submit when checked.
	 */
	onChange: (payload: AcceptancePayload | null) => void;
	/** Controlled mode. Omit to let the component hold its own state. */
	checked?: boolean;
	method?: AcceptanceMethod;
	locale?: string;
	name?: string;
	id?: string;
	disabled?: boolean;
	required?: boolean;
	className?: string;
	labelClassName?: string;
	linkClassName?: string;
	/** Open document links in a new tab. Default `true`. */
	newTab?: boolean;
	/**
	 * Render the label yourself — the sentence around the links differs per locale
	 * and per legal entity, and it is not this component's business to guess it.
	 */
	renderLabel?: (links: React.ReactNode[], documents: readonly RequiredDocument[]) => React.ReactNode;
	/** Prefix used by the default label, e.g. "I agree to the". */
	labelPrefix?: string;
	/** Emitted alongside the payload for analytics/debugging. */
	'data-testid'?: string;
}

/**
 * An unstyled checkbox that gates a submit button **and** produces the evidence.
 *
 * ```tsx
 * const [terms, setTerms] = useState<AcceptancePayload | null>(null);
 *
 * <TermsCheckbox documents={required} onChange={setTerms} />
 * <button disabled={!terms} onClick={() => signUp({ email, password, terms })}>Create account</button>
 * ```
 */
export function TermsCheckbox(props: TermsCheckboxProps) {
	const {
		documents,
		onChange,
		checked,
		method = 'signup-checkbox',
		locale,
		name = 'termsAccepted',
		id = 'terms-accepted',
		disabled,
		required = true,
		className,
		labelClassName,
		linkClassName,
		newTab = true,
		renderLabel,
		labelPrefix = 'I agree to the',
	} = props;

	const [internal, setInternal] = useState(false);
	const isControlled = checked !== undefined;
	const isChecked = isControlled ? checked : internal;

	const buildPayload = useCallback((): AcceptancePayload => {
		return {
			accepted: true,
			method,
			locale: locale ?? documents[0]?.locale ?? 'en',
			clientAcceptedAt: new Date().toISOString(),
			documents: documents.map((doc) => ({
				documentId: doc.documentId,
				version: doc.version,
				sha256: doc.sha256,
				locale: locale ?? doc.locale,
			})),
		};
	}, [documents, locale, method]);

	const handleChange = useCallback(
		(event: React.ChangeEvent<HTMLInputElement>) => {
			const next = event.target.checked;
			if (!isControlled) setInternal(next);
			onChange(next ? buildPayload() : null);
		},
		[buildPayload, isControlled, onChange]
	);

	const links = useMemo(
		() =>
			documents.map((doc, index) => (
				<a
					key={doc.documentId}
					href={doc.url ?? '#'}
					className={linkClassName}
					{...(newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
					data-document-id={doc.documentId}
					data-document-version={doc.version}
				>
					{doc.title ?? doc.documentId}
					{index < documents.length - 1 ? '' : ''}
				</a>
			)),
		[documents, linkClassName, newTab]
	);

	return (
		<span className={className} data-testid={props['data-testid'] ?? 'terms-checkbox'}>
			<input
				type="checkbox"
				id={id}
				name={name}
				checked={isChecked}
				onChange={handleChange}
				disabled={disabled}
				required={required}
				aria-required={required}
			/>{' '}
			<label htmlFor={id} className={labelClassName}>
				{renderLabel ? (
					renderLabel(links, documents)
				) : (
					<>
						{labelPrefix}{' '}
						{links.map((link, index) => (
							<span key={documents[index]?.documentId ?? index}>
								{link}
								{index < links.length - 2 ? ', ' : index === links.length - 2 ? ' and ' : ''}
							</span>
						))}
					</>
				)}
			</label>
			{/*
			 * The versions are mirrored into hidden inputs so a plain <form> POST — no
			 * JavaScript state involved — still carries the evidence. Without this, a
			 * progressively-enhanced form silently degrades to "checkbox, no record".
			 */}
			{isChecked &&
				documents.map((doc) => (
					<input
						key={doc.documentId}
						type="hidden"
						name={`${name}[]`}
						value={`${doc.documentId}@${doc.version}#${doc.sha256}`}
					/>
				))}
		</span>
	);
}
