// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	LinkIcon, ListBulletsIcon, ListNumbersIcon, QuotesIcon, TextBIcon, TextItalicIcon, TextStrikethroughIcon, TextTSlashIcon,
	TextUnderlineIcon,
} from "@phosphor-icons/react";
import LinkExtension from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import { type Editor as TipTap, EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef } from "react";
import { useShortcuts } from "./shortcuts";

export interface EditorProps {
	/** HTML. A change from outside replaces the content; typing reports through onChange. */
	value: string;
	onChange: (html: string) => void;
	placeholder: string;
	size?: "inline" | "window";
	autoFocus?: boolean;
	label?: string;
	onReady?: (editor: TipTap) => void;
}

export function Editor({ value, onChange, placeholder, size = "inline", autoFocus, label = "Message body", onReady }: EditorProps) {
	const last = useRef(value);
	const editor = useEditor({
		immediatelyRender: false,
		extensions: [StarterKit.configure({ link: false, underline: false }), Underline, LinkExtension.configure({ openOnClick: false, autolink: true })],
		content: value,
		editorProps: { attributes: { "aria-label": label, role: "textbox", "aria-multiline": "true" } },
		onUpdate: ({ editor: e }) => {
			const html = e.isEmpty ? "" : e.getHTML();
			last.current = html;
			onChange(html);
		},
	});

	useEffect(() => {
		if (editor && onReady) onReady(editor);
	}, [editor]); // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => {
		if (!editor || editor.isDestroyed || value === last.current) return;
		last.current = value;
		editor.commands.setContent(value || "", { emitUpdate: false });
	}, [value, editor]);

	useEffect(() => {
		if (!editor || !autoFocus) return;
		const id = requestAnimationFrame(() => !editor.isDestroyed && editor.commands.focus("start"));
		return () => cancelAnimationFrame(id);
	}, [editor, autoFocus]);

	const state = useEditorState({ editor, selector: ({ editor: e }) => ({ empty: !e || e.isEmpty }) });
	// The editor is created after the first render, already holding its content, and no transaction tells
	// useEditorState; asking the editor too keeps the placeholder off text it already has.
	const empty = !!state?.empty && (!editor || editor.isEmpty);

	return (
		<div
			className="pg-editor"
			data-size={size}
			style={{ position: "relative" }}
			onKeyDown={(e) => {
				if (editor && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
					e.preventDefault();
					e.stopPropagation();
					promptLink(editor);
				}
			}}
		>
			{empty && (
				<span aria-hidden style={{ position: "absolute", left: 14, top: 12, color: "var(--pg-text-8)", font: "14px/1.6 var(--pg-font)", pointerEvents: "none" }}>
					{placeholder}
				</span>
			)}
			<EditorContent editor={editor} />
		</div>
	);
}

function promptLink(editor: TipTap) {
	const previous = editor.getAttributes("link").href as string | undefined;
	const url = window.prompt("Link URL", previous ?? "https://");
	if (url === null) return;
	if (url === "") editor.chain().focus().extendMarkRange("link").unsetLink().run();
	else editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
}

/** B I U S · lists, quote · link, clear. */
export function FormatBar({ editor }: { editor: TipTap | null }) {
	const { tip } = useShortcuts();
	const state = useEditorState({
		editor,
		selector: ({ editor: e }) => ({
			bold: !!e?.isActive("bold"),
			italic: !!e?.isActive("italic"),
			underline: !!e?.isActive("underline"),
			strike: !!e?.isActive("strike"),
			bullet: !!e?.isActive("bulletList"),
			ordered: !!e?.isActive("orderedList"),
			quote: !!e?.isActive("blockquote"),
			link: !!e?.isActive("link"),
		}),
	});
	const run = (fn: (e: TipTap) => void) => (event: React.MouseEvent) => {
		event.preventDefault();
		if (editor) fn(editor);
	};
	return (
		<div className="pg-format" role="toolbar" aria-label="Formatting">
			<button type="button" title={tip("bold", "Bold")} aria-label="Bold" aria-pressed={state?.bold} onMouseDown={run((e) => e.chain().focus().toggleBold().run())}><TextBIcon size={15} weight="bold" /></button>
			<button type="button" title={tip("italic", "Italic")} aria-label="Italic" aria-pressed={state?.italic} onMouseDown={run((e) => e.chain().focus().toggleItalic().run())}><TextItalicIcon size={15} /></button>
			<button type="button" title={tip("underline", "Underline")} aria-label="Underline" aria-pressed={state?.underline} onMouseDown={run((e) => e.chain().focus().toggleUnderline().run())}><TextUnderlineIcon size={15} /></button>
			<button type="button" title="Strikethrough" aria-label="Strikethrough" aria-pressed={state?.strike} onMouseDown={run((e) => e.chain().focus().toggleStrike().run())}><TextStrikethroughIcon size={15} /></button>
			<span className="pg-sep" />
			<button type="button" title="Bulleted list" aria-label="Bulleted list" aria-pressed={state?.bullet} onMouseDown={run((e) => e.chain().focus().toggleBulletList().run())}><ListBulletsIcon size={15} /></button>
			<button type="button" title="Numbered list" aria-label="Numbered list" aria-pressed={state?.ordered} onMouseDown={run((e) => e.chain().focus().toggleOrderedList().run())}><ListNumbersIcon size={15} /></button>
			<button type="button" title="Quote" aria-label="Quote" aria-pressed={state?.quote} onMouseDown={run((e) => e.chain().focus().toggleBlockquote().run())}><QuotesIcon size={15} /></button>
			<span className="pg-sep" />
			<button type="button" title="Insert link (⌘K)" aria-label="Insert link" aria-pressed={state?.link} onMouseDown={run(promptLink)}><LinkIcon size={15} /></button>
			<button type="button" title="Clear formatting" aria-label="Clear formatting" onMouseDown={run((e) => e.chain().focus().unsetAllMarks().clearNodes().run())}><TextTSlashIcon size={15} /></button>
		</div>
	);
}
