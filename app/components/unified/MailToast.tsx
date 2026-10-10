// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { XIcon } from "@phosphor-icons/react";
import { useEffect } from "react";

export interface ToastState {
	id: number;
	message: string;
	/** Offer Undo while the toast is up. */
	onUndo?: () => void;
	/** Stays until replaced, for progress. */
	sticky?: boolean;
}

const TOAST_MS = 8_000;

/** One toast at a time, 8 seconds, with Undo when the action can be reversed. */
export default function MailToast({ toast, onClose }: { toast: ToastState | null; onClose: () => void }) {
	useEffect(() => {
		if (!toast || toast.sticky) return;
		const timer = window.setTimeout(onClose, TOAST_MS);
		return () => window.clearTimeout(timer);
	}, [toast, onClose]);

	if (!toast) return null;
	return (
		<div className="mail-toast" role="status" aria-live="polite">
			<span>{toast.message}</span>
			{toast.onUndo && (
				<button type="button" className="mail-toast-undo" onClick={() => { toast.onUndo?.(); }}>
					Undo
				</button>
			)}
			<button type="button" className="mail-toast-close" aria-label="Dismiss" onClick={onClose}>
				<XIcon size={12} weight="bold" />
			</button>
		</div>
	);
}
