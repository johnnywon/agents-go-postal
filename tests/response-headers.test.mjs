import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { loadTs } from "./helpers/sqlite.mjs";

const { withSecurityHeaders } = await loadTs("workers/lib/security-headers.ts");

test("security headers add frame protections and merge the CSP directive", () => {
	const response = withSecurityHeaders(new Response("ok", {
		headers: { "Content-Security-Policy": "default-src 'self'; sandbox" },
	}));
	assert.equal(response.headers.get("X-Frame-Options"), "DENY");
	assert.equal(response.headers.get("Content-Security-Policy"), "default-src 'self'; sandbox; frame-ancestors 'none'");

	const withoutPolicy = withSecurityHeaders(new Response("ok"));
	assert.equal(withoutPolicy.headers.get("Content-Security-Policy"), "frame-ancestors 'none'");
});

test("security headers skip WebSocket upgrades and rebuild immutable responses", async () => {
	const upgrade = { status: 101, headers: new Headers(), body: null };
	assert.equal(withSecurityHeaders(upgrade), upgrade);
	assert.equal(upgrade.headers.has("X-Frame-Options"), false);

	const websocket = { status: 200, headers: new Headers(), body: null, webSocket: {} };
	assert.equal(withSecurityHeaders(websocket), websocket);
	assert.equal(websocket.headers.has("X-Frame-Options"), false);

	const immutableHeaders = new Headers();
	immutableHeaders.set = () => { throw new TypeError("immutable headers"); };
	const immutable = {
		status: 200,
		statusText: "OK",
		headers: immutableHeaders,
		body: new Response("body").body,
	};
	const rebuilt = withSecurityHeaders(immutable);
	assert.notEqual(rebuilt, immutable);
	assert.equal(rebuilt.headers.get("X-Frame-Options"), "DENY");
	assert.equal(await rebuilt.text(), "body");
});

const apiBundle = await build({
	entryPoints: ["workers/index.ts"],
	bundle: true,
	platform: "node",
	format: "esm",
	write: false,
});
const { app: apiApp } = await import(
	`data:text/javascript;base64,${Buffer.from(apiBundle.outputFiles[0].text).toString("base64")}`
);

function apiEnvironment() {
	return {
		EMAIL_ADDRESSES: ["hello@example.com"],
		BUCKET: {
			head: async () => ({}),
			get: async () => ({ body: new Blob(["attachment"]).stream() }),
		},
		MAILBOX: {
			idFromName: (name) => name,
			get: () => ({
				getAttachment: async () => ({ filename: "report.pdf", mimetype: "application/pdf" }),
			}),
		},
	};
}

test("attachment downloads include nosniff and sandbox headers", async () => {
	const response = await apiApp.request(
		"http://mail.example.com/api/v1/mailboxes/hello@example.com/emails/email-id/attachments/attachment-id",
		{},
		apiEnvironment(),
	);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
	assert.equal(response.headers.get("Content-Security-Policy"), "sandbox");
});

test("production bundles do not grant localhost CORS", async () => {
	const response = await apiApp.request(
		"http://mail.example.com/api/v1/config",
		{
			method: "OPTIONS",
			headers: {
				Origin: "http://localhost:5173",
				"Access-Control-Request-Method": "GET",
			},
		},
		apiEnvironment(),
	);
	assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});

const appBundle = await build({
	entryPoints: ["workers/app.ts"],
	bundle: true,
	platform: "node",
	format: "esm",
	write: false,
	define: { "import.meta.env": JSON.stringify({ DEV: true, MODE: "test" }) },
	plugins: [{
		name: "app-test-stubs",
		setup(build) {
			const stubs = {
				"virtual:react-router/server-build": "export default {};",
				"react-router": "export const createRequestHandler = () => () => new Response('spa');",
				"agents": "export const routeAgentRequest = async () => new Response('agent');",
				"jose": "export const jwtVerify = async () => ({}); export const createRemoteJWKSet = () => ({});",
				"./cron": "export const runCron = async () => {};",
				"./lib/access-config": "export const accessConfigError = () => null; export const accessJwks = () => ({}); export const getAccessUrls = () => ({});",
				"./lib/error-page": "export const errorResponse = () => new Response('error');",
				"./index": "import { Hono } from 'hono'; export const app = new Hono(); export const receiveEmail = async () => {};",
				"./mcp": "export class EmailMCP { static serve() { return { fetch: async () => new Response('mcp') }; } }",
				"./durableObject": "export class MailboxDO {}",
				"./durableObject/mail-index": "export class MailIndexDO {}",
				"./agent": "export class EmailAgent {}",
			};
			build.onResolve({ filter: /.*/ }, (args) => {
				if (args.path === "virtual:react-router/server-build") return { path: args.path, namespace: "app-stub" };
				if (args.importer.endsWith("/workers/app.ts") && stubs[args.path]) {
					return { path: args.path, namespace: "app-stub" };
				}
			});
			build.onLoad({ filter: /.*/, namespace: "app-stub" }, (args) => ({
				contents: stubs[args.path],
				loader: "js",
				resolveDir: process.cwd(),
			}));
		},
	}],
});
const appModule = await import(
	`data:text/javascript;base64,${Buffer.from(appBundle.outputFiles[0].text).toString("base64")}`
);

test("/mcp and /mcp/* refuse requests from foreign origins", async () => {
	for (const path of ["/mcp", "/mcp/session"]) {
		const response = await appModule.default.fetch(new Request(`https://mail.example.com${path}`, {
			headers: { Origin: "https://evil.example.net" },
		}), {}, { waitUntil() {} });
		assert.equal(response.status, 403);
		assert.equal(await response.text(), "Cross-origin request refused");
		assert.equal(response.headers.get("X-Frame-Options"), "DENY");
		assert.equal(response.headers.get("Content-Security-Policy"), "frame-ancestors 'none'");
	}
});
