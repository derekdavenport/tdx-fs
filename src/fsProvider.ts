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

	constructor(name: string) {
		this.type = vscode.FileType.Directory;
		this.ctime = Date.now();
		this.mtime = Date.now();
		this.size = 0;
		this.name = name;
		this.entries = new Map();
	}
}

export type Entry = File | Directory;

export class TdxFS implements vscode.FileSystemProvider {

	root = new Directory('');
	private session?: TdxSession;

	setSession(session: TdxSession | undefined): void {
		this.session = session;
	}

	getSession(): TdxSession | undefined {
		return this.session;
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

		const entry = this.root.entries.get(fileName);
		if (!entry || entry instanceof Directory) {
			throw new Error(`File not found: "${fileName}"`);
		}

		const file = entry as File;
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
		const textareaMatch = html.match(/<textarea[^>]*id="CKEContent_Content"[^>]*>([\s\S]*?)<\/textarea>/i);
		if (!textareaMatch) {
			throw new Error(`Could not find CKEContent_Content textarea for ${fileName}`);
		}

		const escapedContent = textareaMatch[1];

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

		// Extract the base path from the file URL to construct the save endpoint
		const entry = this.root.entries.get(fileName);
		if (!entry || entry instanceof Directory) {
			throw new Error(`File not found: "${fileName}"`);
		}

		const file = entry as File;
		if (!file.url) {
			throw new Error(`No URL found for file: ${fileName}`);
		}

		// Fetch the edit page to extract all form fields
		const fullUrl = new URL(file.url, session.baseUrl).toString();
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

		// Get the base path by removing the query string
		const baseUrl = file.url.split('?')[0];
		const basePath = baseUrl.substring(0, baseUrl.lastIndexOf('/'));
		
		// Extract the moduleId from the URL
		const moduleIdMatch = file.url.match(/modID=(\d+)/i);
		const moduleId = moduleIdMatch ? moduleIdMatch[1] : '0';
		
		const saveUrl = `${basePath}/DesktopModuleEditSave?moduleID=${moduleId}`;
		const fullSaveUrl = new URL(saveUrl, session.baseUrl).toString();

		// Construct the form data with all fields from the example
		const formData = new URLSearchParams();
        //token = 'qf69StR-NyeOfE2411ayF9Csz46ZMkOI9-bkZP6gV-JP6hq05zJJTVmNbnPbOnw26nZB5AyNkSMsE4SPQgLtdntdpzsL3IXOu6yFHb_3E3ee_RMb0';
		formData.append('__RequestVerificationToken', token);
		formData.append('IsForNext', getFieldValue('IsForNext') || 'False');
		formData.append('IsForClient', getFieldValue('IsForClient') || 'True');
		formData.append('ModuleClientPortalApplicationID', getFieldValue('ModuleClientPortalApplicationID') || '');
		formData.append('ClientPortalCategoryName', getSelectValue('ClientPortalCategoryName') || 'TDClient');
		formData.append('Name', fileName);
		formData.append('ShowBorder', 'true');
		formData.append('ShowBorder', 'false');
		formData.append('ShowName', 'true');
		formData.append('ShowName', 'false');
		formData.append('IsSanitized', 'True');
		formData.append('IsSanitized', 'false');
		formData.append('CKEContent.Content', htmlContent);
		formData.append('CKEContent.EditorKey', getFieldValue('CKEContent.EditorKey') || '');

		const formBody = formData.toString();

		const saveResponse = await this.fetchWithCookieJar(fullSaveUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
				'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
				'Referer': new URL(file.url, session.baseUrl).toString(),
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

	setHtmlModules(modules: Array<{ name: string; url: string }>): void {
		this.root.entries.clear();
		const fileChangeEvents: vscode.FileChangeEvent[] = [];

		for (const module of modules) {
			const file = new File(module.name, module.url);
			this.root.entries.set(module.name, file);
			
			// Create a file change event for this file
			const fileUri = vscode.Uri.from({ scheme: 'tdx', path: `/${module.name}` });
			fileChangeEvents.push({ type: vscode.FileChangeType.Created, uri: fileUri });
		}
		
		// Emit change event for the root directory itself
		const rootUri = vscode.Uri.from({ scheme: 'tdx', path: '/' });
		fileChangeEvents.push({ type: vscode.FileChangeType.Changed, uri: rootUri });
		
		this._fireSoon(...fileChangeEvents);
	}

	// --- manage file metadata

	stat(uri: vscode.Uri): vscode.FileStat {
		const result = this._lookup(uri, false);
		return result;
	}

	readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
		const entry = this._lookupAsDirectory(uri, false);
		const result: [string, vscode.FileType][] = [];
		for (const [name, child] of entry.entries) {
			result.push([name, child.type]);
		}
		return result;
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