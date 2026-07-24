/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as vscode from 'vscode';
import { CookieJar } from 'tough-cookie';

export interface TdxSession {
	baseUrl: string;
	cookieJar: CookieJar;
	lastUpdated: number;
}

export class File implements vscode.FileStat {

	type: vscode.FileType;
	ctime: number;
	mtime: number;
	size: number;

	name: string;
	data?: Uint8Array;
	url?: string;

	constructor(name: string, url?: string) {
		this.type = vscode.FileType.File;
		this.ctime = Date.now();
		this.mtime = Date.now();
		this.size = 0;
		this.name = name;
		this.url = url;
	}
}

export class Directory implements vscode.FileStat {

	type: vscode.FileType;
	ctime: number;
	mtime: number;
	size: number;

	name: string;
	entries: Map<string, File | Directory>;
	baseUrl?: string;  // Store metadata like the HTML Modules page URL

	constructor(name: string, baseUrl?: string) {
		this.type = vscode.FileType.Directory;
		this.ctime = Date.now();
		this.mtime = Date.now();
		this.size = 0;
		this.name = name;
		this.entries = new Map();
		this.baseUrl = baseUrl;
	}
}

export type Entry = File | Directory;

/**
 * Sanitize filenames by replacing problematic characters with safe alternatives.
 * Slashes are replaced with "／" to preserve readability while avoiding path ambiguity.
 */
function sanitizeFileName(name: string): string {
	return name.replace(/\//g, '／');
}

/**
 * Unsanitize filenames by reversing the sanitization.
 */
function unsanitizeFileName(name: string): string {
	return name.replace(/／/g, '/');
}

export class TdxFS implements vscode.FileSystemProvider {

	root = new Directory('Apps');
	private session?: TdxSession;
	private moduleRefreshCallback?: () => Promise<{ modules: Array<{ name: string; url: string }>; htmlModulesPageUrl: string }>;
	private appRefreshCallback?: (appName: string) => Promise<{ modules: Array<{ name: string; url: string }>; htmlModulesPageUrl: string }>;
	private refreshTimestamps = new Map<string, number>();
	private refreshDebounceMs = 5 * 1000; // 5 seconds
	private isRefreshing = new Map<string, boolean>();

	setSession(session: TdxSession | undefined): void {
		this.session = session;
	}

	getSession(): TdxSession | undefined {
		return this.session;
	}

	setModuleRefreshCallback(callback: () => Promise<{ modules: Array<{ name: string; url: string }>; htmlModulesPageUrl: string }>): void {
		this.moduleRefreshCallback = callback;
	}

	setAppRefreshCallback(callback: (appName: string) => Promise<{ modules: Array<{ name: string; url: string }>; htmlModulesPageUrl: string }>): void {
		this.appRefreshCallback = callback;
	}

	private async fetchWithCookieJar(url: string, options?: RequestInit): Promise<Response> {
		const session = this.session;
		if (!session) {
			throw new Error('No active TeamDynamix session');
		}

		// Get cookies for this URL from the jar
		const cookieHeader = await session.cookieJar.getCookieString(url);
		
		// Prepare headers with cookies
		const headers = new Headers(options?.headers || {});
		if (cookieHeader) {
			headers.set('Cookie', cookieHeader);
		}

		// Make the request
		const response = await fetch(url, {
			...options,
			headers,
		});

		// Extract and store any Set-Cookie headers from the response
		const setCookieHeaders = response.headers.getSetCookie?.() || [];
		for (const setCookieHeader of setCookieHeaders) {
			try {
				await session.cookieJar.setCookie(setCookieHeader, url);
			} catch (error) {
				// Silently ignore cookie parsing errors - some cookies may be malformed
			}
		}

		return response;
	}

	async fetchFileContent(fileName: string): Promise<string> {
		const session = this.session;
		if (!session) {
			throw new Error('No active TeamDynamix session');
		}

		// Find the file - search in nested structure
		let file: File | undefined;
		
		// Check Client Portal Apps
		const clientPortalAppsDir = this.root.entries.get('Client Portal Apps');
		if (clientPortalAppsDir && clientPortalAppsDir instanceof Directory) {
			for (const appEntry of clientPortalAppsDir.entries.values()) {
				if (appEntry instanceof Directory) {
					const htmlModulesDir = appEntry.entries.get('HTML Modules');
					if (htmlModulesDir && htmlModulesDir instanceof Directory) {
						const sanitizedName = sanitizeFileName(fileName);
						const foundFile = htmlModulesDir.entries.get(sanitizedName) as File;
						if (foundFile) {
							file = foundFile;
							break;
						}
					}
				}
			}
		}

		// Check Ticketing Apps
		if (!file) {
			const ticketingAppsDir = this.root.entries.get('Ticketing Apps');
			if (ticketingAppsDir && ticketingAppsDir instanceof Directory) {
				for (const appEntry of ticketingAppsDir.entries.values()) {
					if (appEntry instanceof Directory) {
						// Check Notification Templates
						const notificationTemplatesDir = appEntry.entries.get('Notification Templates');
						if (notificationTemplatesDir && notificationTemplatesDir instanceof Directory) {
							const sanitizedName = sanitizeFileName(fileName);
							const foundFile = notificationTemplatesDir.entries.get(sanitizedName) as File;
							if (foundFile) {
								file = foundFile;
								break;
							}
						}
					}
				}
			}
		}

		// Fallback check in root level HTML Modules for compatibility
		if (!file) {
			const htmlModulesDir = this.root.entries.get('HTML Modules');
			if (htmlModulesDir && htmlModulesDir instanceof Directory) {
				const sanitizedName = sanitizeFileName(fileName);
				file = htmlModulesDir.entries.get(sanitizedName) as File;
			}
		}

		// Fallback check in root for compatibility
		if (!file) {
			const sanitizedName = sanitizeFileName(fileName);
			const entry = this.root.entries.get(sanitizedName);
			if (entry && entry instanceof File) {
				file = entry;
			}
		}
		
		if (!file) {
			throw new Error(`File not found: "${fileName}"`);
		}

		if (!file.url) {
			throw new Error(`No URL found for file: ${fileName}`);
		}

		const fullUrl = new URL(file.url, session.baseUrl).toString();

		const response = await this.fetchWithCookieJar(fullUrl);

		if (!response.ok) {
			throw new Error(`Failed to fetch file ${fileName}: ${response.statusText}`);
		}

		const html = await response.text();

		// Extract the HTML content from the textarea with id="CKEContent_Content"
		let contentMatch = html.match(/<textarea[^>]*id="CKEContent_Content"[^>]*>([\s\S]*?)<\/textarea>/i);
		if (!contentMatch) {
			contentMatch = html.match(/<div[^>]*class="well code"[^>]*>([\s\S]*?)<\/div>/i);
			// If that's not there, 
			if (!contentMatch) {
				throw new Error(`Could not find HTML content in the fetched page for file: ${fileName}`);
			}
			contentMatch[1] = contentMatch[1].trim().replace(/<br\s*\/?>/gi, '\n');
			// @todo: mark read only

		}

		const escapedContent = contentMatch[1];

		// Unescape HTML entities - do &amp; last to avoid double-unescaping
		const unescaped = escapedContent
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"')
			.replace(/&#039;/g, "'")
			.replace(/&amp;/g, '&');

		// Cache the content in the file object
		const contentBuffer = Buffer.from(unescaped, 'utf8');
		file.data = new Uint8Array(contentBuffer);
		file.size = file.data.length;

		return unescaped;
	}

	async saveFileContent(fileName: string, htmlContent: string): Promise<void> {
		const session = this.session;
		if (!session) {
			throw new Error('No active TeamDynamix session');
		}

		// Find the file - search in nested structure
		let file: File | undefined;
		let parentDir: Directory | undefined;
		
		// Check Client Portal Apps
		const clientPortalAppsDir = this.root.entries.get('Client Portal Apps');
		if (clientPortalAppsDir && clientPortalAppsDir instanceof Directory) {
			for (const appEntry of clientPortalAppsDir.entries.values()) {
				if (appEntry instanceof Directory) {
					const htmlModulesDir = appEntry.entries.get('HTML Modules');
					if (htmlModulesDir && htmlModulesDir instanceof Directory) {
						const sanitizedName = sanitizeFileName(fileName);
						const foundFile = htmlModulesDir.entries.get(sanitizedName) as File;
						if (foundFile) {
							file = foundFile;
							parentDir = htmlModulesDir;
							break;
						}
					}
				}
			}
		}

		// Check Ticketing Apps
		if (!file) {
			const ticketingAppsDir = this.root.entries.get('Ticketing Apps');
			if (ticketingAppsDir && ticketingAppsDir instanceof Directory) {
				for (const appEntry of ticketingAppsDir.entries.values()) {
					if (appEntry instanceof Directory) {
						// Check Notification Templates
						const notificationTemplatesDir = appEntry.entries.get('Notification Templates');
						if (notificationTemplatesDir && notificationTemplatesDir instanceof Directory) {
							const sanitizedName = sanitizeFileName(fileName);
							const foundFile = notificationTemplatesDir.entries.get(sanitizedName) as File;
							if (foundFile) {
								file = foundFile;
								parentDir = notificationTemplatesDir;
								break;
							}
						}
					}
				}
			}
		}

		// Fallback check in root level HTML Modules for compatibility
		if (!file) {
			const htmlModulesDir = this.root.entries.get('HTML Modules');
			if (htmlModulesDir && htmlModulesDir instanceof Directory) {
				const sanitizedName = sanitizeFileName(fileName);
				file = htmlModulesDir.entries.get(sanitizedName) as File;
				if (file) {
					parentDir = htmlModulesDir;
				}
			}
		}
		
		// Fallback check in root for compatibility
		if (!file) {
			const sanitizedName = sanitizeFileName(fileName);
			const entry = this.root.entries.get(sanitizedName);
			if (entry && entry instanceof File) {
				file = entry;
				parentDir = this.root;
			}
		}
		
		if (!file) {
			throw new Error(`File not found: "${fileName}"`);
		}
		
		// For new files without a URL, construct a default URL with moduleId = 0
		let moduleId = '0';
		let editPageUrl: string;
		
		if (file.url) {
			editPageUrl = file.url;
			// Extract the moduleId from the URL if it exists
			const moduleIdMatch = file.url.match(/modID=(\d+)/i);
			moduleId = moduleIdMatch ? moduleIdMatch[1] : '0';
		} else {
			// New module - use the parent directory's baseUrl if available (for HTML Modules)
			if (parentDir?.baseUrl) {
				// Extract the base path from the htmlModulesPageUrl and append 
				const baseUrlPath = parentDir.baseUrl.replace(/^([^?]*).*$/, '$1');
				editPageUrl = new URL('HtmlModuleEdit', baseUrlPath).toString();
			} else {
				throw new Error(`Cannot determine edit page URL for new file: "${fileName}"`);
			}
		}

		// Fetch the edit page to extract all form fields
		const fullUrl = new URL(editPageUrl, session.baseUrl).toString();
		const response = await this.fetchWithCookieJar(fullUrl, {
			redirect: 'manual'  // Don't follow redirects automatically
		});

		if (response.status === 302 || response.status === 301 || response.status === 303 || response.status === 307) {
			console.error(`[TdxFS] Got redirect! This likely means cookies are stale. Redirect URL: ${response.headers.get('location')}`);
			throw new Error(`Got redirect when fetching edit page - cookies may be stale`);
		}

		if (!response.ok) {
			throw new Error(`Failed to fetch edit page for form fields: ${response.statusText}`);
		}

		const html = await response.text();

		// Extract form field values using regex
		const getFieldValue = (fieldName: string): string => {
			const regex = new RegExp(`<input[^>]*name="${fieldName}"[^>]*value="([^"]*)"`);
			const match = html.match(regex);
			return match ? match[1] : '';
		};

		const getCheckboxValue = (fieldName: string): string => {
			const regex = new RegExp(`<input[^>]*name="${fieldName}"[^>]*value="([^"]*)"`);
			const match = html.match(regex);
			return match && match[0].includes('checked="checked"') ? 'true' : 'false';
		};

		const getSelectValue = (fieldName: string): string => {
			const regex = new RegExp(`<select[^>]*name="${fieldName}"[^>]*>([\\s\\S]*?)<option[^>]*selected[^>]*value="([^"]*)"`);
			const match = html.match(regex);
			return match ? match[2] : '';
		};

		// Extract a FRESH token right before saving
		const tokenMatch = html.match(/<input[^>]*name="__RequestVerificationToken"[^>]*value="([^"]*)"/i);
		let token = tokenMatch ? tokenMatch[1] : '';
		if (!token) {
			throw new Error('Could not extract verification token from edit page');
		}

		// Construct the save URL
		const base = file.url ? session.baseUrl + file.url : parentDir?.baseUrl;
		if (!base) {
			throw new Error(`Cannot determine base url for saving file: "${fileName}"`);
		}
		//		editPageUrl = new URL('HtmlModuleEdit', baseUrlPath).toString();;
		// /TDAdmin/71907D89-441A-48BE-9CD6-A59A2C5EA305/277/DesktopTemplates/DesktopModuleEditSave?moduleID=0
		const saveUrl = new URL('DesktopModuleEditSave', base);
		saveUrl.searchParams.append('moduleID', moduleId);
		const saveUrlString = saveUrl.toString();

		// Construct the form data with all fields from the example
		const formData = new URLSearchParams();
		formData.append('__RequestVerificationToken', token);
		formData.append('IsForNext', getFieldValue('IsForNext') || 'False');
		formData.append('IsForClient', getFieldValue('IsForClient') || 'True');
		formData.append('ModuleClientPortalApplicationID', getFieldValue('ModuleClientPortalApplicationID') || '');
		formData.append('ClientPortalCategoryName', getSelectValue('ClientPortalCategoryName') || 'TDClient');
		formData.append('Name', file.name);  // Use the original module name, not the sanitized one
		formData.append('ShowBorder', getCheckboxValue('ShowBorder') || 'false');
		formData.append('ShowName', getCheckboxValue('ShowName') || 'false');
		formData.append('IsSanitized', 'True');
		formData.append('IsSanitized', 'false');
		formData.append('CKEContent.Content', htmlContent);
		formData.append('CKEContent.EditorKey', getFieldValue('CKEContent.EditorKey') || '');

		const formBody = formData.toString();

		const saveResponse = await this.fetchWithCookieJar(saveUrl.toString(), {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
				'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
				'Referer': fullUrl,
				'Origin': new URL(session.baseUrl).origin,
				'X-Requested-With': 'XMLHttpRequest',
				'Sec-Fetch-Dest': 'empty',
				'Sec-Fetch-Mode': 'cors',
				'Sec-Fetch-Site': 'same-origin',
			},
			body: formBody,
		});

		// Accept both successful responses (2xx) and redirects (3xx)
		if (saveResponse.status < 200 || saveResponse.status >= 400) {
			throw new Error(`Failed to save file: ${saveResponse.status} ${saveResponse.statusText}`);
		}
	}

	setClientPortalApps(apps: Array<{ appName: string; htmlModulesPageUrl?: string; modules: Array<{ name: string; url: string }> }>): void {
		// Create or get the "Client Portal Apps" directory
		let clientPortalAppsDir = this.root.entries.get('Client Portal Apps') as Directory | undefined;
		if (!clientPortalAppsDir) {
			clientPortalAppsDir = new Directory('Client Portal Apps');
			this.root.entries.set('Client Portal Apps', clientPortalAppsDir);
		}

		// Clear existing apps
		clientPortalAppsDir.entries.clear();

		// Populate each Client Portal app
		for (const app of apps) {
			const sanitizedAppName = sanitizeFileName(app.appName);
			const appDir = new Directory(app.appName);
			clientPortalAppsDir.entries.set(sanitizedAppName, appDir);

			// Create HTML Modules subdirectory
			const htmlModulesDir = new Directory('HTML Modules', app.htmlModulesPageUrl);
			appDir.entries.set('HTML Modules', htmlModulesDir);

			// Populate HTML Modules
			for (const module of app.modules) {
				const sanitizedModuleName = sanitizeFileName(module.name);
				const file = new File(module.name, module.url);
				htmlModulesDir.entries.set(sanitizedModuleName, file);
			}
		}
	}

	setClientPortalApp(app: { appName: string; htmlModulesPageUrl?: string; modules: Array<{ name: string; url: string }> }): void {
		// Create or get the "Client Portal Apps" directory
		let clientPortalAppsDir = this.root.entries.get('Client Portal Apps') as Directory | undefined;
		if (!clientPortalAppsDir) {
			clientPortalAppsDir = new Directory('Client Portal Apps');
			this.root.entries.set('Client Portal Apps', clientPortalAppsDir);
		}

		// Update only this specific app (preserves other apps)
		const sanitizedAppName = sanitizeFileName(app.appName);
		const appDir = new Directory(app.appName);
		clientPortalAppsDir.entries.set(sanitizedAppName, appDir);

		// Create HTML Modules subdirectory
		const htmlModulesDir = new Directory('HTML Modules', app.htmlModulesPageUrl);
		appDir.entries.set('HTML Modules', htmlModulesDir);

		// Populate HTML Modules
		for (const module of app.modules) {
			const sanitizedModuleName = sanitizeFileName(module.name);
			const file = new File(module.name, module.url);
			htmlModulesDir.entries.set(sanitizedModuleName, file);
		}
	}

	setTicketingApps(apps: Array<{ appName: string }>): void {
		// Create or get the "Ticketing Apps" directory
		let ticketingAppsDir = this.root.entries.get('Ticketing Apps') as Directory | undefined;
		if (!ticketingAppsDir) {
			ticketingAppsDir = new Directory('Ticketing Apps');
			this.root.entries.set('Ticketing Apps', ticketingAppsDir);
		}

		// Clear existing apps
		ticketingAppsDir.entries.clear();

		// Populate each Ticketing app
		for (const app of apps) {
			const sanitizedAppName = sanitizeFileName(app.appName);
			const appDir = new Directory(app.appName);
			ticketingAppsDir.entries.set(sanitizedAppName, appDir);

			// Create Notification Templates subdirectory (placeholder for now)
			const notificationTemplatesDir = new Directory('Notification Templates');
			appDir.entries.set('Notification Templates', notificationTemplatesDir);
		}
	}

	// --- manage file metadata

	stat(uri: vscode.Uri): vscode.FileStat {
		const result = this._lookup(uri, false);
		return result;
	}

	readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
		const entry = this._lookupAsDirectory(uri, false);
		
		// Determine if this is a root read or app-specific read, and trigger appropriate refresh
		if (uri.path === '/') {
			// Root read: refresh app lists
			this._triggerRefreshIfNeeded('root', this.moduleRefreshCallback);
		} else {
			// Check if this is an app folder read (e.g., /Client Portal Apps/[AppName])
			const appMatch = uri.path.match(/^\/(Client Portal Apps|Ticketing Apps)\/([^\/]+)$/);
			if (appMatch && this.appRefreshCallback) {
				const appName = decodeURIComponent(appMatch[2]);
				this._triggerRefreshIfNeeded(`app:${appName}`, () => this.appRefreshCallback!(appName));
			}
		}
		
		const result: [string, vscode.FileType][] = [];
		for (const [name, child] of entry.entries) {
			result.push([name, child.type]);
		}
		return result;
	}

	private _triggerRefreshIfNeeded(path: string, callback?: () => Promise<any>): void {
		if (!callback) return;
		
		const now = Date.now();
		const lastRefresh = this.refreshTimestamps.get(path) ?? 0;
		const isRefreshing = this.isRefreshing.get(path) ?? false;
		
		if (now - lastRefresh >= this.refreshDebounceMs && !isRefreshing) {
			this.refreshTimestamps.set(path, now);
			this.isRefreshing.set(path, true);
			
			void callback()
				.catch((error) => {
					console.error(`[TdxFS] Failed to refresh ${path}: ${error}`);
				})
				.finally(() => {
					this.isRefreshing.set(path, false);
				});
		}
	}

	// --- manage file contents

	readFile(uri: vscode.Uri): Uint8Array {
		const file = this._lookupAsFile(uri, false);
		
		if (file.data) {
			return file.data;
		}
		
		// File not cached, start fetching in background
		const fileName = decodeURIComponent(uri.path.split('/').pop() || '');
		
		void this.fetchFileContent(fileName)
			.then(() => {
				this._fireSoon({ type: vscode.FileChangeType.Changed, uri });
			})
			.catch((error) => {
				console.error(`[TdxFS] Failed to fetch content for ${fileName}: ${error}`);
			});
		
		// Return empty buffer for now - VS Code will reload when fetch completes
		return new Uint8Array(0);
	}

	writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean, overwrite: boolean }): void {
		const basename = uri.path.split('/').pop()!;
		const decodedBasename = decodeURIComponent(basename);
		const parent = this._lookupParentDirectory(uri);
		let entry = parent.entries.get(decodedBasename);
		if (entry instanceof Directory) {
			throw vscode.FileSystemError.FileIsADirectory(uri);
		}
		if (!entry && !options.create) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		if (entry && options.create && !options.overwrite) {
			throw vscode.FileSystemError.FileExists(uri);
		}
		if (!entry) {
			entry = new File(decodedBasename);
			parent.entries.set(decodedBasename, entry);
			this._fireSoon({ type: vscode.FileChangeType.Created, uri });
		}
		entry.mtime = Date.now();
		entry.size = content.byteLength;
		entry.data = content;

		this._fireSoon({ type: vscode.FileChangeType.Changed, uri });

		// Save to TeamDynamix in the background
		const htmlContent = Buffer.from(content).toString('utf-8');
		void this.saveFileContent(decodedBasename, htmlContent)
			.catch((error) => {
				console.error(`[TdxFS] Background save failed for ${decodedBasename}: ${error}`);
			});
	}

	// --- manage files/folders

	rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): void {

		if (!options.overwrite && this._lookup(newUri, true)) {
			throw vscode.FileSystemError.FileExists(newUri);
		}

		const entry = this._lookup(oldUri, false);
		const oldParent = this._lookupParentDirectory(oldUri);

		const newParent = this._lookupParentDirectory(newUri);
		const newName = decodeURIComponent(newUri.path.split('/').pop() || '');

		oldParent.entries.delete(entry.name);
		entry.name = newName;
		newParent.entries.set(newName, entry);

		this._fireSoon(
			{ type: vscode.FileChangeType.Deleted, uri: oldUri },
			{ type: vscode.FileChangeType.Created, uri: newUri }
		);
	}

	delete(uri: vscode.Uri): void {
		const dirname = uri.with({ path: uri.path.substring(0, uri.path.lastIndexOf('/')) });
		const basename = uri.path.split('/').pop()!;
		const decodedBasename = decodeURIComponent(basename);
		const parent = this._lookupAsDirectory(dirname, false);
		if (!parent.entries.has(decodedBasename)) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		parent.entries.delete(decodedBasename);
		parent.mtime = Date.now();
		parent.size -= 1;
		this._fireSoon({ type: vscode.FileChangeType.Changed, uri: dirname }, { uri, type: vscode.FileChangeType.Deleted });
	}

	createDirectory(uri: vscode.Uri): void {
		const basename = decodeURIComponent(uri.path.split('/').pop() || '');
		const dirname = uri.with({ path: uri.path.substring(0, uri.path.lastIndexOf('/')) });
		const parent = this._lookupAsDirectory(dirname, false);

		const entry = new Directory(basename);
		parent.entries.set(entry.name, entry);
		parent.mtime = Date.now();
		parent.size += 1;
		this._fireSoon({ type: vscode.FileChangeType.Changed, uri: dirname }, { type: vscode.FileChangeType.Created, uri });
	}

	// --- lookup

	private _lookup(uri: vscode.Uri, silent: false): Entry;
	private _lookup(uri: vscode.Uri, silent: boolean): Entry | undefined;
	private _lookup(uri: vscode.Uri, silent: boolean): Entry | undefined {
		const parts = uri.path.split('/');
		let entry: Entry = this.root;
		for (const part of parts) {
			if (!part) {
				continue;
			}
			// Decode URI component to handle spaces and special characters
			const decodedPart = decodeURIComponent(part);
			let child: Entry | undefined;
			if (entry instanceof Directory) {
				child = entry.entries.get(decodedPart);
			}
			if (!child) {
				if (!silent) {
					throw vscode.FileSystemError.FileNotFound(uri);
				} else {
					return undefined;
				}
			}
			entry = child;
		}
		return entry;
	}

	private _lookupAsDirectory(uri: vscode.Uri, silent: boolean): Directory {
		const entry = this._lookup(uri, silent);
		if (entry instanceof Directory) {
			return entry;
		}
		throw vscode.FileSystemError.FileNotADirectory(uri);
	}

	private _lookupAsFile(uri: vscode.Uri, silent: boolean): File {
		const entry = this._lookup(uri, silent);
		if (entry instanceof File) {
			return entry;
		}
		throw vscode.FileSystemError.FileIsADirectory(uri);
	}

	private _lookupParentDirectory(uri: vscode.Uri): Directory {
		const dirname = uri.with({ path: uri.path.substring(0, uri.path.lastIndexOf('/')) });
		return this._lookupAsDirectory(dirname, false);
	}

	// --- manage file events

	private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	private _bufferedEvents: vscode.FileChangeEvent[] = [];
	private _fireSoonHandle?: ReturnType<typeof setTimeout>;

	readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

	watch(_resource: vscode.Uri): vscode.Disposable {
		// ignore, fires for all changes...
		return new vscode.Disposable(() => { });
	}

	private _fireSoon(...events: vscode.FileChangeEvent[]): void {
		this._bufferedEvents.push(...events);

		if (this._fireSoonHandle) {
			clearTimeout(this._fireSoonHandle);
		}

		this._fireSoonHandle = setTimeout(() => {
			this._emitter.fire(this._bufferedEvents);
			this._bufferedEvents.length = 0;
		}, 5);
	}
}