// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { CookieJar } from 'tough-cookie';
import { TdxFS, type TdxSession } from './fsProvider';

const SESSION_COOKIE_SECRET_KEY = 'tdx.sessionCookie';
const BASE_URL_KEY = 'tdx.baseUrl';
const LOGIN_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const LOGIN_POLL_INTERVAL_MS = 2000;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Extension activation

	const tdxFs = new TdxFS();
	context.subscriptions.push(vscode.workspace.registerFileSystemProvider('tdx', tdxFs, { isCaseSensitive: true }));

	// Set up the module refresh callback that readDirectory can use
	tdxFs.setModuleRefreshCallback(async () => {
		const cookieHeader = await context.secrets.get(SESSION_COOKIE_SECRET_KEY);
		const baseUrl = context.globalState.get<string>(BASE_URL_KEY);
		
		if (!cookieHeader || !baseUrl) {
			return { modules: [], htmlModulesPageUrl: '' };
		}

		try {
			const clientPortalUrl = await getClientPortalUrl(baseUrl, cookieHeader);
			const htmlModulesPageUrl = await getHtmlModulesPageUrl(clientPortalUrl, cookieHeader);
			const modules = await getAllHtmlModules(htmlModulesPageUrl, cookieHeader, baseUrl);
			// Return both modules and the htmlModulesPageUrl
			return { modules, htmlModulesPageUrl };
		} catch (error) {
			console.error(`[Extension] Module refresh callback failed: ${error}`);
			return { modules: [], htmlModulesPageUrl: '' };
		}
	});

	// Restore session and defer workspace opening to after activation completes
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
		await loginWithPlaywright(context, tdxFs);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('tdx-fs.clearSession', async () => {
		await context.secrets.delete(SESSION_COOKIE_SECRET_KEY);
		await context.globalState.update(BASE_URL_KEY, undefined);
		tdxFs.setSession(undefined);
		tdxFs.setHtmlModules([]);
		vscode.window.showInformationMessage('Cleared TeamDynamix session cookie.');
	}));

	context.subscriptions.push(vscode.commands.registerCommand('tdx-fs.refresh', async () => {
		const cookieHeader = await context.secrets.get(SESSION_COOKIE_SECRET_KEY);
		const baseUrl = context.globalState.get<string>(BASE_URL_KEY);
		
		if (!cookieHeader || !baseUrl) {
			vscode.window.showInformationMessage('No active TeamDynamix session. Run "TeamDynamix: Initialize Session" first.');
			return;
		}

		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Refreshing HTML Modules...' },
			async () => {
				try {
					const clientPortalUrl = await getClientPortalUrl(baseUrl, cookieHeader);
					const htmlModulesPageUrl = await getHtmlModulesPageUrl(clientPortalUrl, cookieHeader);
					const modules = await getAllHtmlModules(htmlModulesPageUrl, cookieHeader, baseUrl);
					tdxFs.setHtmlModules(modules, htmlModulesPageUrl);
					vscode.window.showInformationMessage(`Refreshed ${modules.length} HTML Modules.`);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					vscode.window.showErrorMessage(`Failed to refresh modules: ${message}`);
				}
			}
		);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('tdx-fs.openWorkspace', async () => {
		const tdxUri = vscode.Uri.from({ scheme: 'tdx', path: '/' });
		await vscode.commands.executeCommand('vscode.openFolder', tdxUri);
	}));

	// Listen for when files are opened and fetch their content if not already cached
	context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(async (doc) => {
		if (doc.uri.scheme === 'tdx' && doc.lineCount === 0) {
			const encodedFileName = doc.uri.path.split('/').pop();
			if (encodedFileName) {
				// Decode URI component to handle spaces and special characters
				const fileName = decodeURIComponent(encodedFileName);
				try {
					await vscode.window.withProgress(
						{ location: vscode.ProgressLocation.Notification, title: `Loading ${fileName}...` },
						async () => {
							await tdxFs.fetchFileContent(fileName);
						}
					);
					// Reload the document to show the fetched content
					await vscode.commands.executeCommand('vscode.open', doc.uri);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					console.error(`[Extension] Failed to fetch file content: ${message}`);
					vscode.window.showErrorMessage(`Failed to load file: ${message}`);
				}
			}
		}
	}));

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('tdx-fs.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from TeamDynamix File System!');
	});

	context.subscriptions.push(disposable);
}

async function loginWithPlaywright(context: vscode.ExtensionContext, tdxFs: TdxFS): Promise<void> {
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

	const playwright = await loadPlaywright(context);
	if (!playwright) {
		throw new Error('playwright-core is required for TeamDynamix authentication');
	}

	let browserContext: PlaywrightBrowserContextLike | undefined;
	let cookieHeader: string | undefined;

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

		void vscode.window.showInformationMessage('Complete the Microsoft sign-in in Edge. Waiting for the browser to return to TeamDynamix.');

		const returnedToBaseUrl = await waitForBaseUrl(browserContext, baseUrl);
		if (!returnedToBaseUrl) {
			throw new Error('Timed out waiting for browser to return to TeamDynamix after SSO. Please verify the base URL and network connectivity.');
		}

		cookieHeader = await waitForTeamDynamixCookies(browserContext, baseUrl);
		if (!cookieHeader) {
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

	if (!cookieHeader) {
		return;
	}

	await saveSession(context, tdxFs, baseUrl, cookieHeader);
	vscode.window.showInformationMessage('TeamDynamix session captured with Playwright and saved.');

	// Load HTML modules and populate the file system
	try {
		const progress = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: 'Loading HTML Modules from TeamDynamix...' },
			async () => {
				const clientPortalUrl = await getClientPortalUrl(baseUrl, cookieHeader);
				const htmlModulesPageUrl = await getHtmlModulesPageUrl(clientPortalUrl, cookieHeader);
				const modules = await getAllHtmlModules(htmlModulesPageUrl, cookieHeader, baseUrl);
				tdxFs.setHtmlModules(modules, htmlModulesPageUrl);
				return modules.length;
			}
		);

		vscode.window.showInformationMessage(`Loaded ${progress} HTML Modules from TeamDynamix.`);

		// Open the tdx workspace to display the files
		const tdxUri = vscode.Uri.from({ scheme: 'tdx', path: '/' });
		await vscode.commands.executeCommand('vscode.openFolder', tdxUri);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Failed to load HTML Modules: ${message}`);
		vscode.window.showWarningMessage(`Failed to load HTML Modules: ${message}`);
	}
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

async function waitForTeamDynamixCookies(browserContext: PlaywrightBrowserContextLike, baseUrl: string): Promise<string | undefined> {
	const deadline = Date.now() + LOGIN_WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const cookieHeader = await buildCookieHeaderFromContext(browserContext, baseUrl);
		if (cookieHeader) {
			return cookieHeader;
		}

		await delay(LOGIN_POLL_INTERVAL_MS);
	}

	return undefined;
}

async function loadPlaywright(context: vscode.ExtensionContext): Promise<PlaywrightLike> {
	try {
		const nodeRequire = requireFromExtension(context.extensionPath);
		const resolvedPath = nodeRequire.resolve('playwright-core');
		const module = nodeRequire(resolvedPath) as { chromium: PlaywrightLike['chromium'] };
		return {
			chromium: module.chromium
		};
	} catch(error) {
		const details = error instanceof Error ? error.message : String(error);
		throw new Error(`playwright-core dependency could not be loaded: ${details}`);
	}
}

function requireFromExtension(extensionPath: string): NodeJS.Require {
	return createRequire(`${extensionPath}/package.json`);
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
	tdxFs.setSession(session);
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
	
	tdxFs.setSession({
		baseUrl,
		cookieJar,
		lastUpdated: Date.now()
	});

	// Restore HTML modules on startup
	try {
		const clientPortalUrl = await getClientPortalUrl(baseUrl, cookieHeader);
		const htmlModulesPageUrl = await getHtmlModulesPageUrl(clientPortalUrl, cookieHeader);
		const modules = await getAllHtmlModules(htmlModulesPageUrl, cookieHeader, baseUrl);
		tdxFs.setHtmlModules(modules, htmlModulesPageUrl);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[Extension] Failed to restore HTML Modules on startup: ${message}`);
	}
}

export interface HtmlModule {
	name: string;
	url: string;
}

async function fetchPageWithCookies(url: string, cookieHeader: string): Promise<string> {
	const response = await fetch(url, {
		headers: {
			'Cookie': cookieHeader
		}
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
	}

	return response.text();
}

function extractLinkFromHtml(html: string, linkText: string): string | undefined {
	// Match <a> tags with href attribute containing the specified link text
	const regex = new RegExp(`<a[^>]*href="([^"]*)"[^>]*>\\s*${linkText}\\s*</a>`, 'i');
	const match = html.match(regex);
	return match ? match[1] : undefined;
}

async function getClientPortalUrl(baseUrl: string, cookieHeader: string): Promise<string> {
	const appInstancesUrl = `${baseUrl}/TDAdmin/BE/AppInstances/`;
	const html = await fetchPageWithCookies(appInstancesUrl, cookieHeader);

	// Find the grdAppInstances table and extract the Client Portal link
	const tableMatch = html.match(/<table[^>]*id="grdAppInstances"[^>]*>[\s\S]*?<\/table>/i);
	if (!tableMatch) {
		throw new Error('Could not find grdAppInstances table on AppInstances page');
	}

	const tableHtml = tableMatch[0];
	const clientPortalLink = extractLinkFromHtml(tableHtml, 'Client Portal');

	if (!clientPortalLink) {
		throw new Error('Could not find Client Portal link in grdAppInstances table');
	}

	// Resolve relative URLs
	const url = new URL(clientPortalLink, baseUrl);
	return url.toString();
}

async function getHtmlModulesPageUrl(clientPortalUrl: string, cookieHeader: string): Promise<string> {
	const html = await fetchPageWithCookies(clientPortalUrl, cookieHeader);

	const htmlModulesLink = extractLinkFromHtml(html, 'HTML Modules');
	if (!htmlModulesLink) {
		throw new Error('Could not find HTML Modules link on Client Portal page');
	}

	// Resolve relative URLs
	const url = new URL(htmlModulesLink, clientPortalUrl);
	return url.toString();
}

interface GridRow {
	columns: string[];
}

function parseGridItems(html: string): HtmlModule[] {
	const modules: HtmlModule[] = [];

	// Find the gridItems table
	const tableMatch = html.match(/<table[^>]*id="gridItems"[^>]*>[\s\S]*?<\/table>/i);
	if (!tableMatch) {
		throw new Error('Could not find gridItems table on HTML Modules page');
	}

	const tableHtml = tableMatch[0];

	// Extract all rows from tbody
	const tbodyMatch = tableHtml.match(/<tbody[^>]*>[\s\S]*?<\/tbody>/i);
	if (!tbodyMatch) {
		return modules;
	}

	const tbodyHtml = tbodyMatch[0];

	// Extract each row
	const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
	let rowMatch;

	while ((rowMatch = rowRegex.exec(tbodyHtml)) !== null) {
		const rowHtml = rowMatch[0];

		// Extract columns (td elements)
		const columns: string[] = [];
		const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
		let cellMatch;

		while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
			columns.push(cellMatch[1].trim());
		}

		if (columns.length < 2) {
			continue;
		}

		// The second column has the link to the module
		const secondColumnHtml = columns[1];
		const linkMatch = secondColumnHtml.match(/<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/i);

		if (linkMatch) {
			const url = linkMatch[1];
			const name = linkMatch[2].trim();

			if (name) {
				modules.push({ name, url });
			}
		}
	}

	return modules;
}

async function getAllHtmlModules(htmlModulesPageUrl: string, cookieHeader: string, baseUrl: string): Promise<HtmlModule[]> {
	const allModules: HtmlModule[] = [];
	let pageNumber = 1;
	const maxPages = 100; // Safety limit to prevent infinite loops

	while (pageNumber <= maxPages) {
		let pageUrl = htmlModulesPageUrl;
		// Append page parameter if not the first page
		if (pageNumber > 1) {
			const separator = htmlModulesPageUrl.includes('?') ? '&' : '?';
			pageUrl = `${htmlModulesPageUrl}${separator}page=${pageNumber}`;
		}

		try {
			const html = await fetchPageWithCookies(pageUrl, cookieHeader);
			const modules = parseGridItems(html);

			if (modules.length === 0) {
				// No modules found, stop pagination
				break;
			}

			allModules.push(...modules);

			// Look for next page link in the tfoot - check if page N+1 exists
			const tfootMatch = html.match(/<tfoot[^>]*>[\s\S]*?<\/tfoot>/i);
			if (!tfootMatch) {
				break;
			}

			const tfootHtml = tfootMatch[0];

			// Look for a link with the next page number as text
			const nextPageNumber = pageNumber + 1;
			const nextPageRegex = new RegExp(`<a[^>]*href="([^"]*)"[^>]*>\\s*${nextPageNumber}\\s*</a>`, 'i');
			const nextPageMatch = tfootHtml.match(nextPageRegex);

			if (!nextPageMatch) {
				// No next page link found, we're done
				break;
			}

			pageNumber++;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`Failed to fetch page ${pageNumber}: ${message}`);
			break;
		}
	}

	return allModules;
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
