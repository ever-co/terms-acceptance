import { useCallback, useEffect, useRef, useState } from 'react';
import type { AcceptanceMethod, AcceptanceStatus, PendingDocument } from '../types.js';
import type { AcceptancePayload } from './TermsCheckbox.js';

export interface ReacceptModalProps {
	/** Result of `service.status(...)` for the signed-in user. */
	status: AcceptanceStatus | null | undefined;
	/**
	 * Send the acceptance to your API. Resolve on success; the modal closes itself.
	 * Reject to show the error and keep the modal open.
	 */
	onAccept: (payload: AcceptancePayload) => Promise<void>;
	/** Offered when the modal is blocking, since the alternative to agreeing is leaving. */
	onSignOut?: () => void | Promise<void>;
	locale?: string;
	method?: AcceptanceMethod;
	title?: string;
	description?: string;
	acceptLabel?: string;
	signOutLabel?: string;
	className?: string;
	/** Replace the default inline styling with your own classes. */
	unstyled?: boolean;
	/** Render the body yourself. */
	children?: (documents: PendingDocument[]) => React.ReactNode;
}

/**
 * The blocking re-acceptance modal.
 *
 * It renders only when `status.blocking` is non-empty, and while it is open there is
 * no dismiss button, no backdrop click, and no Escape — which is the point. A
 * material change to the terms is exactly the case where "remind me later" is not a
 * real option, and a modal that can be dismissed is a modal that produces no record.
 *
 * Non-material changes never reach here; they arrive as `status.notices` and belong
 * in a banner.
 */
export function ReacceptModal(props: ReacceptModalProps) {
	const {
		status,
		onAccept,
		onSignOut,
		locale,
		method = 'reaccept-modal',
		title = 'We have updated our terms',
		description = 'Please review and accept the updated documents to continue.',
		acceptLabel = 'I agree',
		signOutLabel = 'Sign out',
		className,
		unstyled,
		children,
	} = props;

	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const acceptRef = useRef<HTMLButtonElement | null>(null);

	const blocking = status?.blocking ?? [];
	const open = blocking.length > 0;

	useEffect(() => {
		if (open) acceptRef.current?.focus();
	}, [open]);

	// Keep the page behind the modal from scrolling while consent is outstanding.
	useEffect(() => {
		if (!open || typeof document === 'undefined') return;
		const previous = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			document.body.style.overflow = previous;
		};
	}, [open]);

	const accept = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			await onAccept({
				accepted: true,
				method,
				locale: locale ?? 'en',
				clientAcceptedAt: new Date().toISOString(),
				documents: blocking.map((doc) => ({
					documentId: doc.documentId,
					version: doc.requiredVersion,
					sha256: doc.requiredSha256,
					locale: locale ?? 'en',
				})),
			});
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}, [blocking, locale, method, onAccept]);

	if (!open) return null;

	const overlayStyle: React.CSSProperties | undefined = unstyled
		? undefined
		: {
				position: 'fixed',
				inset: 0,
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				background: 'rgba(0,0,0,.55)',
				zIndex: 2147483000,
				padding: '1rem',
			};

	const panelStyle: React.CSSProperties | undefined = unstyled
		? undefined
		: {
				background: '#fff',
				color: '#111',
				borderRadius: 12,
				maxWidth: 520,
				width: '100%',
				padding: '1.5rem',
				boxShadow: '0 10px 40px rgba(0,0,0,.3)',
				font: '15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif',
			};

	return (
		<div
			style={overlayStyle}
			className={className}
			data-testid="terms-reaccept-modal"
			role="presentation"
			// No onClick: the backdrop is not an escape hatch.
		>
			<div role="alertdialog" aria-modal="true" aria-labelledby="terms-reaccept-title" style={panelStyle}>
				<h2 id="terms-reaccept-title" style={unstyled ? undefined : { margin: '0 0 .5rem', fontSize: '1.15rem' }}>
					{title}
				</h2>
				<p style={unstyled ? undefined : { margin: '0 0 1rem' }}>{description}</p>

				{children ? (
					children(blocking)
				) : (
					<ul style={unstyled ? undefined : { margin: '0 0 1.25rem', paddingLeft: '1.1rem' }}>
						{blocking.map((doc) => (
							<li key={doc.documentId} style={unstyled ? undefined : { marginBottom: '.5rem' }}>
								{doc.url ? (
									<a href={doc.url} target="_blank" rel="noopener noreferrer">
										{doc.title ?? doc.documentId}
									</a>
								) : (
									(doc.title ?? doc.documentId)
								)}{' '}
								<small>
									v{doc.requiredVersion}
									{doc.acceptedVersion ? ` (you accepted v${doc.acceptedVersion})` : ' (new)'}
								</small>
								{doc.changes.length > 0 && (
									<ul style={unstyled ? undefined : { margin: '.25rem 0 0', paddingLeft: '1rem' }}>
										{doc.changes
											.filter((change) => change.summary)
											.map((change) => (
												<li key={change.version}>
													<small>
														v{change.version}: {change.summary}
													</small>
												</li>
											))}
									</ul>
								)}
							</li>
						))}
					</ul>
				)}

				{error && (
					<p role="alert" style={unstyled ? undefined : { color: '#b00020', margin: '0 0 .75rem' }}>
						{error}
					</p>
				)}

				<div style={unstyled ? undefined : { display: 'flex', gap: '.5rem', justifyContent: 'flex-end' }}>
					{onSignOut && (
						<button type="button" onClick={() => void onSignOut()} disabled={busy}>
							{signOutLabel}
						</button>
					)}
					<button ref={acceptRef} type="button" onClick={() => void accept()} disabled={busy}>
						{busy ? '…' : acceptLabel}
					</button>
				</div>
			</div>
		</div>
	);
}
