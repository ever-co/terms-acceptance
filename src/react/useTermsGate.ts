import { useCallback, useEffect, useState } from 'react';
import type { AcceptanceStatus } from '../types.js';
import type { AcceptancePayload } from './TermsCheckbox.js';

export interface UseTermsGateOptions {
	/** Endpoint returning an {@link AcceptanceStatus}. Default `/api/terms/status`. */
	statusUrl?: string;
	/** Endpoint accepting an {@link AcceptancePayload}. Default `/api/terms/accept`. */
	acceptUrl?: string;
	/** Skip the fetch — e.g. while the session is still loading. */
	enabled?: boolean;
	/** Injected for tests and for apps that route through their own client. */
	fetcher?: typeof fetch;
}

export interface TermsGate {
	status: AcceptanceStatus | null;
	loading: boolean;
	error: Error | null;
	/** `true` when at least one document is blocking. */
	blocked: boolean;
	accept: (payload: AcceptancePayload) => Promise<void>;
	refresh: () => Promise<void>;
}

/**
 * Fetch the signed-in user's terms status and expose an `accept` that re-checks
 * afterwards.
 *
 * Deliberately thin: the gate is enforced on the server (a session that has not
 * accepted should not get data), and this hook only drives the UI. A client-side
 * gate on its own is a suggestion, not a gate.
 */
export function useTermsGate(options: UseTermsGateOptions = {}): TermsGate {
	const {
		statusUrl = '/api/terms/status',
		acceptUrl = '/api/terms/accept',
		enabled = true,
		fetcher = typeof fetch !== 'undefined' ? fetch : undefined,
	} = options;

	const [status, setStatus] = useState<AcceptanceStatus | null>(null);
	const [loading, setLoading] = useState(enabled);
	const [error, setError] = useState<Error | null>(null);

	const refresh = useCallback(async () => {
		if (!enabled || !fetcher) return;
		setLoading(true);
		setError(null);
		try {
			const response = await fetcher(statusUrl, { credentials: 'include' });
			if (!response.ok) throw new Error(`terms status ${response.status}`);
			setStatus((await response.json()) as AcceptanceStatus);
		} catch (cause) {
			setError(cause instanceof Error ? cause : new Error(String(cause)));
		} finally {
			setLoading(false);
		}
	}, [enabled, fetcher, statusUrl]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const accept = useCallback(
		async (payload: AcceptancePayload) => {
			if (!fetcher) throw new Error('useTermsGate: no fetch implementation available');
			const response = await fetcher(acceptUrl, {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload),
			});
			if (!response.ok) throw new Error(`terms accept ${response.status}`);
			await refresh();
		},
		[acceptUrl, fetcher, refresh]
	);

	return { status, loading, error, blocked: (status?.blocking.length ?? 0) > 0, accept, refresh };
}
