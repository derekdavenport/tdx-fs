// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'node:path';
import CM from './client.js';
import { Cookie, CookieJar } from 'tough-cookie';
import { TdxFS, type TdxSession } from './fsProvider.js';
import playwright from 'playwright-core';

const SESSION_COOKIE_SECRET_KEY = 'tdx.sessionCookie';
const BASE_URL_KEY = 'tdx.baseUrl';
const LOGIN_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const LOGIN_POLL_INTERVAL_MS = 2000;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Extension activation
	const baseUrl = context.globalState.get<string>(BASE_URL_KEY);
	if (baseUrl) {
		CM.setBaseUrl(baseUrl);
	}
	context.secrets.get(SESSION_COOKIE_SECRET_KEY).then(cookieHeader => {
		cookieHeader?.split(/;\s*/).forEach(cookieStr => {
			const cookie = Cookie.parse(cookieStr);
			if (cookie) {
				CM.setCookie(cookie);
			}
		});
		//CM.setCookie(cookieHeader);
	});
	CM.setLogin(async () => await loginWithPlaywright(context));
	
	const tdxFs = new TdxFS();
	context.subscriptions.push(vscode.workspace.registerFileSystemProvider('tdx', tdxFs, { isCaseSensitive: true }));


	void restoreSession(context, tdxFs).then(() => {
		// After restoreSession completes, defer opening the workspace
		setTimeout(() => {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			const hasTdxWorkspace = workspaceFolders?.some((folder) => folder.uri.scheme === 'tdx');
			if (!hasTdxWorkspace) {

				const tdxUri = vscode.Uri.from({ scheme: 'tdx', path: '/' });
				void vscode.commands.executeCommand('vscode.openFolder', tdxUri);
			}
		}, 500);
	});

	context.subscriptions.push(vscode.commands.registerCommand('tdx-fs.init', async () => {
		// await loginWithPlaywright(context);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('tdx-fs.clearSession', async () => {
		await context.secrets.delete(SESSION_COOKIE_SECRET_KEY);
		await context.globalState.update(BASE_URL_KEY, undefined);
		// tdxFs.setSession(undefined);
		// @todo: clear the cookie jar in the client
		vscode.window.showInformationMessage('Cleared TeamDynamix session cookie.');
	}));


	context.subscriptions.push(vscode.commands.registerCommand('tdx-fs.openWorkspace', async () => {
		const tdxUri = vscode.Uri.from({ scheme: 'tdx', path: '/' });
		await vscode.commands.executeCommand('vscode.openFolder', tdxUri);
	}));

	// Listen for when files are opened and fetch their content if not already cached
	context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(async (doc) => {
		if (doc.uri.scheme === 'tdx' && doc.lineCount === 0) {
			// @todo: might be mustache
			vscode.languages.setTextDocumentLanguage(doc, 'html');
		}
	}));

}

async function loginWithPlaywright(context: vscode.ExtensionContext): Promise<Cookie[] | undefined> {
	const previousBaseUrl = context.globalState.get<string>(BASE_URL_KEY) ?? '';
	const enteredBaseUrl = await vscode.window.showInputBox({
		title: 'TeamDynamix URL',
		prompt: 'Enter your TeamDynamix base URL (example: https://yourcompany.teamdynamix.com)',
		value: previousBaseUrl,
		ignoreFocusOut: true,
		validateInput: validateBaseUrl
	});

	if (!enteredBaseUrl) {
		return;
	}

	const baseUrl = normalizeBaseUrl(enteredBaseUrl);
	await context.globalState.update(BASE_URL_KEY, baseUrl);

	if (!playwright) {
		throw new Error('playwright-core is required for TeamDynamix authentication');
	}

	let browserContext: PlaywrightBrowserContextLike | undefined;
	let cookies: Cookie[] | undefined;

	try {
		browserContext = await playwright.chromium.launchPersistentContext(getPlaywrightUserDataDir(context), {
			headless: false,
			channel: 'msedge'
		});

		const keepAlivePage = browserContext.pages()[0] ?? await browserContext.newPage();
		await keepAlivePage.goto('about:blank').catch(() => undefined);
		const page = await browserContext.newPage();
		await page.goto(`${baseUrl}/TDClient/`, { waitUntil: 'domcontentloaded' }).catch((error: unknown) => {
			// Initial page load may fail if browser navigates away immediately - this is okay
		});

		void vscode.window.showInformationMessage('Complete the sign-in in Edge. Waiting for the browser to return to TeamDynamix.');

		const returnedToBaseUrl = await waitForBaseUrl(browserContext, baseUrl);
		if (!returnedToBaseUrl) {
			throw new Error('Timed out waiting for browser to return to TeamDynamix after SSO. Please verify the base URL and network connectivity.');
		}

		cookies = await waitForTeamDynamixCookies(browserContext, baseUrl);
		if (!cookies) {
			throw new Error('Timed out waiting for TeamDynamix authentication cookies. Please verify your login was successful.');
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Playwright login failed: ${message}`);
		vscode.window.showErrorMessage(`TeamDynamix login failed: ${message}`);
		return;
	} finally {
		if (browserContext) {
			await browserContext.close().catch(() => undefined);
		}
	}

	if (!cookies) {
		return;
	}

	await context.secrets.store(SESSION_COOKIE_SECRET_KEY, cookies.map(cookie => cookie.toString()).join('; '));

	vscode.window.showInformationMessage('TeamDynamix session captured with Playwright and saved.');

	return cookies;
}

async function waitForBaseUrl(browserContext: PlaywrightBrowserContextLike, baseUrl: string): Promise<boolean> {
	const deadline = Date.now() + LOGIN_WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const pages = browserContext.pages();
		for (const page of pages) {
			let currentUrl = '';
			try {
				currentUrl = page.url();
			} catch {
				continue;
			}

			if (isTeamDynamixUrl(currentUrl, baseUrl)) {
				return true;
			}
		}

		await delay(LOGIN_POLL_INTERVAL_MS);
	}

	return false;
}

async function waitForTeamDynamixCookies(browserContext: PlaywrightBrowserContextLike, baseUrl: string): Promise<Cookie[] | undefined> {
	const deadline = Date.now() + LOGIN_WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		// const cookieHeader = await buildCookieHeaderFromContext(browserContext, baseUrl);
		const url = new URL(baseUrl);
	// const host = url.hostname;
	const cookies = (await browserContext.cookies(baseUrl)).map(({ name: key, value, domain }) => new Cookie({
		key,
		value,
		domain,
	}));
	// @todo: check for specific cookie
		if (cookies.length > 0) {
			return cookies;
		}

		await delay(LOGIN_POLL_INTERVAL_MS);
	}

	return undefined;
}

function getPlaywrightUserDataDir(context: vscode.ExtensionContext): string {
	return path.join(context.globalStorageUri.fsPath, 'playwright-profile');
}

async function buildCookieHeaderFromContext(browserContext: PlaywrightBrowserContextLike, baseUrl: string): Promise<string | undefined> {
	const url = new URL(baseUrl);
	const host = url.hostname;
	const cookies = await browserContext.cookies(baseUrl);

	const matchingCookies = cookies.filter((cookie) => {
		// Handle empty domain (host-only cookies) or domain with leading dot
		const normalizedDomain = !cookie.domain
			? host
			: cookie.domain.startsWith('.')
			? cookie.domain.substring(1)
			: cookie.domain;

		return host === normalizedDomain || host.endsWith(`.${normalizedDomain}`);
	});

	if (matchingCookies.length === 0) {
		return undefined;
	}

	// Validate that essential TeamDynamix cookies are present
	const cookieNames = matchingCookies.map((c) => c.name);
	const hasSessionCookie = cookieNames.some((name) => name.toLowerCase().includes('tdsid') || name.toLowerCase().includes('session'));

	if (!hasSessionCookie) {
		console.warn('Warning: No TeamDynamix session cookie (TDSID or session) found. Authentication may fail.');
	}

	return matchingCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

async function saveSession(context: vscode.ExtensionContext, tdxFs: TdxFS, baseUrl: string, cookieHeader: string): Promise<void> {
	await context.secrets.store(SESSION_COOKIE_SECRET_KEY, cookieHeader);

	// Create a CookieJar from the cookie header string
	const cookieJar = new CookieJar();
	const cookies = cookieHeader.split(';').map(c => c.trim());
	for (const cookie of cookies) {
		if (cookie) {
			try {
				await cookieJar.setCookie(cookie, baseUrl);
			} catch (error) {
				console.warn(`[Extension] Failed to set cookie in jar: ${error}`);
			}
		}
	}

	const session: TdxSession = {
		baseUrl,
		cookieJar,
		lastUpdated: Date.now()
	};
	// tdxFs.setSession(session);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}


function normalizeBaseUrl(value: string): string {
	const candidate = value.trim();
	const withProtocol = /^[a-z]+:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
	const url = new URL(withProtocol);
	url.pathname = '';
	url.search = '';
	url.hash = '';
	return url.toString().replace(/\/$/, '');
}

function validateBaseUrl(value: string): string | undefined {
	if (value.trim().length === 0) {
		return 'TeamDynamix base URL is required.';
	}

	try {
		normalizeBaseUrl(value);
		return undefined;
	} catch {
		return 'Enter a valid URL, for example https://yourcompany.teamdynamix.com';
	}
}

function isTeamDynamixUrl(candidateUrl: string, baseUrl: string): boolean {
	if (!candidateUrl) {
		return false;
	}

	try {
		const candidate = new URL(candidateUrl);
		const base = new URL(baseUrl);
		if (candidate.origin !== base.origin) {
			return false;
		}

		return candidate.pathname === '/' || candidate.pathname.startsWith('/TDClient');
	} catch {
		return false;
	}
}

async function restoreSession(context: vscode.ExtensionContext, tdxFs: TdxFS): Promise<void> {
	const cookieHeader = await context.secrets.get(SESSION_COOKIE_SECRET_KEY);
	const baseUrl = context.globalState.get<string>(BASE_URL_KEY);
	if (!cookieHeader || !baseUrl) {
		return;
	}
	
	// Create a CookieJar from the stored cookie header string
	const cookieJar = new CookieJar();
	const cookies = cookieHeader.split(';').map(c => c.trim());
	for (const cookie of cookies) {
		if (cookie) {
			try {
				await cookieJar.setCookie(cookie, baseUrl);
			} catch (error) {
				console.warn(`[Extension] Failed to set cookie in jar during restore: ${error}`);
			}
		}
	}
	
	// tdxFs.setSession({
	// 	baseUrl,
	// 	cookieJar,
	// 	lastUpdated: Date.now()
	// });
}

export interface HtmlModule {
	name: string;
	url: string;
}

export interface AppInstance {
	appId: string;
	appName: string;
	appUrl: string;
	appType: 'Client Portal App' | 'Ticketing App' | 'Unknown';
}

class SessionExpiredError extends Error {
	constructor() {
		super('Session expired - redirected to login');
		this.name = 'SessionExpiredError';
	}
}

interface PlaywrightLike {
	chromium: {
		launchPersistentContext(userDataDir: string, options: { headless: boolean; channel?: string }): Promise<PlaywrightBrowserContextLike>;
	};
}

interface PlaywrightBrowserContextLike {
	close(): Promise<void>;
	newPage(): Promise<PlaywrightPageLike>;
	cookies(urls?: string | string[]): Promise<Array<{ name: string; value: string; domain: string }>>;
	pages(): PlaywrightPageLike[];
}

interface PlaywrightPageLike {
	goto(url: string, options?: { waitUntil?: 'domcontentloaded' | 'load' | 'networkidle' }): Promise<unknown>;
	url(): string;
}

// This method is called when your extension is deactivated
export function deactivate() {}
