/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

function extractLinkFromHtml(html: string, linkText: string): string | undefined {
	// Match <a> tags with href attribute containing the specified link text
	const regex = new RegExp(`<a[^>]*href="([^"]*)"[^>]*>\\s*${linkText}\\s*</a>`, 'i');
	const match = html.match(regex);
	return match ? match[1] : undefined;
}

function extractLinkFromHtmlByTitle(html: string, title: string): string | undefined {
	const regex = new RegExp(`<a[^>]*[^>]+href="([^"]*)"[^>]*[^>]+title="${title}"`, 'i');
	const match = html.match(regex);
	return match ? match[1] : undefined;
}

const getFieldValue = (html: string, fieldName: string): string => {
	const regex = new RegExp(`<input[^>]*name="${fieldName}"[^>]*value="([^"]*)"`);
	const match = html.match(regex);
	return match ? match[1] : '';
};

const getCheckboxValue = (html: string, fieldName: string): string => {
	const regex = new RegExp(`<input[^>]*name="${fieldName}"[^>]*value="([^"]*)"`);
	const match = html.match(regex);
	return match && match[0].includes('checked="checked"') ? 'true' : 'false';
};

const getSelectValue = (html: string, fieldName: string): string => {
	const regex = new RegExp(`<select[^>]*name="${fieldName}"[^>]*>([\\s\\S]*?)<option[^>]*selected[^>]*value="([^"]*)"`);
	const match = html.match(regex);
	return match ? match[2] : '';
};

export interface TableData {
	name: string;
	url: string;
	id: string;
}

function parseGridItems(html: string): TableData[] {
	const modules: TableData[] = [];

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

		const id = columns[0].trim();
		// The second column has the link to the module
		const secondColumnHtml = columns[1];
		const linkMatch = secondColumnHtml.match(/<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/i);

		if (linkMatch) {
			const url = linkMatch[1];
			const name = linkMatch[2].trim();

			if (name) {
				modules.push({ name, url, id });
			}
		}
	}

	return modules;
}

import * as vscode from 'vscode';
import { CookieJar } from 'tough-cookie';
import CM from './client.js';

export interface TdxSession {
	baseUrl: string;
	cookieJar: CookieJar;
	lastUpdated: number;
}

interface RemoteFileStat extends vscode.FileStat {
	url?: string;
	utime: number; // Last updated time from the server
	name: string;
	rawName: string;
	load(): Promise<void>;
}


export class File implements RemoteFileStat {

	type: vscode.FileType;
	ctime: number;
	mtime: number;
	utime: number;
	size: number;

	name: string;
	rawName: string;
	parent: Directory;
	data?: Uint8Array;
	url?: string;

	constructor(name: string, parent: Directory, url: string | undefined = undefined) {
		if (new.target === File) {
			throw new TypeError("Cannot construct File instances directly");
		}
		this.type = vscode.FileType.File;
		this.ctime = Date.now();
		this.mtime = Date.now();
		this.utime = 0;
		this.size = 0;
		this.name = name;
		this.rawName = sanitizeFileName(name);
		this.parent = null as any;  // Will be set when added to a directory
		this.url = url;
	}

	async load(): Promise<void> {
		// To be implemented by subclasses
	}

	async save(): Promise<void> {
		// To be implemented by subclasses
	}
}

export class Directory<T extends File | Directory = any> implements RemoteFileStat {

	type: vscode.FileType;
	ctime: number;
	mtime: number;
	utime: number;
	size: number;

	rawName: string;
	name: string;
	parent: Directory | null;
	entries: Map<string, T>;
	url?: string;  // Store metadata like the HTML Modules page URL

	constructor(name: string, parent: Directory | null = null, url: string | undefined = undefined) {
		this.type = vscode.FileType.Directory;
		this.ctime = Date.now();
		this.mtime = Date.now();
		this.utime = 0;
		this.size = 0;
		this.rawName = name;
		this.name = sanitizeFileName(name);
		this.parent = parent;
		this.entries = new Map();
		this.url = url;
	}

	async load(...args: any[]): Promise<void> {
		// To be implemented by subclasses
	}
}

class RootDirectory extends Directory {
	url: string;
	clientPortalAppsDirectory: ClientPortalAppsDirectory;
	ticketingAppsDirectory: TicketingAppsDirectory;
	
	private tableCache: string;
	private CACHE_DURATION_MS = 5 * 1000; // 5 seconds

	constructor() {
		super('Apps');
		this.url = new URL('/TDAdmin/BE/AppInstances/', CM.client.defaults.options.prefixUrl).toString();
		this.clientPortalAppsDirectory = new ClientPortalAppsDirectory('Client Portal Apps', this);
		this.ticketingAppsDirectory = new TicketingAppsDirectory('Ticketing Apps', this);

		this.entries.set(this.clientPortalAppsDirectory.name, this.clientPortalAppsDirectory);
		this.entries.set(this.ticketingAppsDirectory.name, this.ticketingAppsDirectory);

		this.tableCache = '';
	}

	async getRootAppTable(): Promise<string> {
		const now = Date.now();
		if (now - this.utime > this.CACHE_DURATION_MS) {
			// const appInstancesUrl = '/TDAdmin/BE/AppInstances/';
			const html = await CM.client.get(this.url, {}).text();
			this.utime = now;
			// Find the grdAppInstances table
			const tableMatch = html.match(/<table[^>]*id="grdAppInstances"[^>]*>[\s\S]*?<\/table>/i);
			if (!tableMatch) {
				throw new Error('Could not find grdAppInstances table on AppInstances page');
			}

			const tableHtml = tableMatch[0];

			// Extract all rows from tbody
			const tbodyMatch = tableHtml.match(/<tbody[^>]*>[\s\S]*?<\/tbody>/i);
			if (!tbodyMatch) {
				throw new Error('Could not find table body on AppInstances page');
			}

			const tbodyHtml = tbodyMatch[0];
			this.tableCache = tbodyHtml;
		}
		return this.tableCache;
	}
}
// a directory of apps of a certain type, e.g. directory of Ticketing apps
class AppTypeDirectory<T extends AppType = AppType> extends Directory {
	parent: RootDirectory;
	idToNameMap: Map<string, string>;

	constructor(name: string, parent: RootDirectory) {
		super(name, parent);
		this.url = new URL('', parent.url).toString();
		this.entries = new Map<string, AppDirectory<T>>();
		this.parent = parent;
		this.idToNameMap = new Map<string, string>();
	}

	protected async loadApps(appType: T) {
		// @todo: maybe do a dif instead
		// this.entries.clear();
		const appTable = await this.parent.getRootAppTable();

		// Extract each row
		const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
		let rowMatch;

		const foundApps = new Map<string, TableData>();
		while ((rowMatch = rowRegex.exec(appTable)) !== null) {
			const rowHtml = rowMatch[0];

			// Extract columns (td elements)
			const columns: string[] = [];
			const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
			let cellMatch;

			while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
				columns.push(cellMatch[1].trim());
			}

			// check if app is the right type
			if (columns.length < 3 || !columns[2].includes(appType)) {
				continue;
			}

			// Column 0: App ID
			const appIdText = columns[0].replace(/<[^>]*>/g, '').trim();
			
			// Column 1: App name from link
			const appNameMatch = columns[1].match(/<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/i);
			if (!appNameMatch) {
				continue;
			}

			const appUrl = appNameMatch[1];
			const appName = appNameMatch[2].trim();

			const app = { name: appName, url: appUrl, id: appIdText };
			foundApps.set(appIdText, app);

			// Subclasses will override this to create the correct type
			//this.createAppInstance(appName, appUrl);
		}

		// diff
		const now = Date.now();
		for (const [id, appData] of foundApps) {
			// if we don't have this id, create it
			if (!this.idToNameMap.has(id)) {
				this.addApp(appData);
			}
			const oldName = this.idToNameMap.get(id);
			const app = this.entries.get(oldName || '');
			if (app) {
				app.name = appData.name; // update name in case it changed, url won't change
			}
		}
		// delete old
		for (const entry of this.entries.values()) {
			if (!foundApps.has(entry.id)) {
				this.removeApp(entry);
			}
		}

		// @todo: do I need to emit a change if there was a dif?
	}

	protected createChildInstance({ name, url, id }: TableData): AppDirectory<T> {
		throw new Error('createChildInstance must be implemented by subclasses');
		return new AppDirectory<T>(name, this, url, id);
	}

	protected addApp(tableData: TableData) {
		// To be overridden by subclasses
		this.entries.set(tableData.name, this.createChildInstance(tableData));
		this.idToNameMap.set(tableData.id, tableData.name);
	}

	protected removeApp(app: AppDirectory<T>) {
		this.idToNameMap.delete(app.id);
		this.entries.delete(app.name);
	}
}

// list of all the client portal apps
class ClientPortalAppsDirectory extends AppTypeDirectory<'Client Portal'> {
	entries: Map<string, ClientPortalApp>;
	constructor(name: 'Client Portal Apps', parent: RootDirectory) {
		super(name, parent);
		this.entries = new Map();
	}
	
	async load() {
        await this.loadApps('Client Portal');
		this.utime = Date.now();
    }

	protected createChildInstance({ name, url, id }: TableData) {
		return new ClientPortalApp(name, this, url, id);
	}
}
// list of all the ticketing apps
class TicketingAppsDirectory extends AppTypeDirectory<'Ticketing'> {
	entries: Map<string, TicketingApp>;
	constructor(name: 'Ticketing Apps', parent: RootDirectory) {
		super(name, parent);
		this.entries = new Map<string, TicketingApp>();
	}
	async load() {
        await this.loadApps('Ticketing');
		this.utime = Date.now();
    }

	protected createChildInstance({ name, url, id }: TableData) {
		return new TicketingApp(name, this, url, id);
	}
}

// an app, such as Client Portal or Ticketing
class AppDirectory<T extends AppType = AppType> extends Directory {
	url: string;
	parent: AppTypeDirectory<T>;
	id: string;

	constructor(name: string, parent: AppTypeDirectory<T>, url: string, id: string) {
		super(name, parent, url);
		this.parent = parent;
		this.url = new URL(url, parent.url).toString();
		this.id = id;
	}
}

// a client portal app, currently only has 1 entry: HTML Modules Directory
class ClientPortalApp extends AppDirectory<'Client Portal'> {
	parent: ClientPortalAppsDirectory;
	modulesDirectory: HTMLModulesDirectory;
	constructor(name: string, parent: ClientPortalAppsDirectory, url: string, id: string) {
		super(name, parent, url, id);
		// actually can't be set in constructor because we don't know the url until this page loads
		this.modulesDirectory = new HTMLModulesDirectory('HTML Modules', this);
		this.parent = parent;
		// @todo: don't set entries until load
		this.entries.set(this.modulesDirectory.name, this.modulesDirectory);
	}
	// get the url of HTML Modules page
	// @todo: this will never need to change
	async load() {
		if (this.utime) {
			return;
		}
		const html = await CM.client.get(this.url).text();
		const link = extractLinkFromHtml(html, 'HTML Modules');
		if (!link) {
			throw new Error('Could not find HTML Modules link on Client Portal app page');
		}
		this.modulesDirectory.url = new URL(link, this.url).toString();
		this.utime = Date.now();
		// fire change if different
	}
}
// list of all the html modules
class HTMLModulesDirectory extends Directory<HTMLModule> {
	url: string | undefined = undefined;
	idToNameMap: Map<string, string>;
	newModuleUrl: URL | undefined = undefined;
	constructor(name: 'HTML Modules', parent: ClientPortalApp, url: string | undefined = undefined) {
		super(name, parent, url);
		this.url = url ? new URL(url, parent.url).toString() : undefined;
		this.entries = new Map<string, HTMLModule>();
		this.idToNameMap = new Map<string, string>();
	}

	async load() {
		if (!this.url) {
			//wait
			return;
		}
		const allModules: TableData[] = [];
		let pageNumber = 1;
		const maxPages = 100; // Safety limit to prevent infinite loops
	
		while (pageNumber <= maxPages) {
			let pageUrl = this.url;
			// Append page parameter if not the first page
			if (pageNumber > 1) {
				pageUrl += `?page=${pageNumber}`;
			}
	
			try {
				const html = await CM.client.get(pageUrl).text();
				// get new link
				if (!this.newModuleUrl) {
					const newModuleLink = extractLinkFromHtmlByTitle(html, 'New HTML Module');
					this.newModuleUrl = newModuleLink ? new URL(newModuleLink, this.url) : undefined;
				}
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

		// diff
		const now = Date.now();
		for (const moduleData of allModules) {
			// if we don't have this id, create it
			if (!this.idToNameMap.has(moduleData.id)) {
				this.addChild(moduleData);
			}
			const oldName = this.idToNameMap.get(moduleData.id);
			const module = this.entries.get(oldName || '');
			if (module) {
				module.name = moduleData.name; // update name in case it changed, url won't change
				module.utime = now;
			}
		}
		// delete old
		for (const module of this.entries.values()) {
			if (module.utime < now) {
				this.removeChild(module);
			}
		}
	
		this.utime = Date.now();
	}

	protected addChild(data: TableData) {
		this.entries.set(data.name, new HTMLModule(data.name, this, data.url));
		this.idToNameMap.set(data.id, data.name);
	}

	protected removeChild(module: HTMLModule) {
		this.idToNameMap.delete(module.id);
		this.entries.delete(module.name);
	}

}

class TicketingApp extends AppDirectory<'Ticketing'> {
	parent: TicketingAppsDirectory;
	notificationTemplatesDirectory: NotificationTemplatesDirectory;
	constructor(name: string, parent: TicketingAppsDirectory, url: string, id: string) {
		super(name, parent, url, id);
		this.notificationTemplatesDirectory = new NotificationTemplatesDirectory('Notification Templates', this, url);
		this.parent = parent;
		this.entries.set(this.notificationTemplatesDirectory.name, this.notificationTemplatesDirectory);
	}

	// get the url of Notification Templates page
	// @todo: this will never need to change
	async load() {
		if (this.utime) {
			return;
		}
		const html = await CM.client.get(this.url).text();
		const link = extractLinkFromHtml(html, 'Notification Templates');
		if (!link) {
			throw new Error('Could not find HTML Modules link on Client Portal app page');
		}
		this.notificationTemplatesDirectory.url = new URL(link, this.url).toString();
		this.utime = Date.now();
		// fire change if different
	}
}

class NotificationTemplatesDirectory extends Directory<NotificationTemplate> {
	constructor(name: 'Notification Templates', parent: TicketingApp, url: string) {
		super(name, parent, url);
		this.entries = new Map<string, NotificationTemplate>();
	}

	async load() {
		if (!this.url) {
			//wait
			return;
		}
		const rows = await getTableRows(this.url, 'grdEventTypes');
		for (const row of rows) {
			if (!row['Event Name']?.text || !row['Event Name']?.href) {
				console.log('Skipping row due to missing Event Name or URL:', row);
				continue;
			}
			if (this.entries.has(row['Event Name'].text)) {
				console.log('Skipping row because it already exists:', row);
				continue;
			}
			this.entries.set(row['Event Name'].text, new NotificationTemplate(row['Event Name'].text, this, row['Event Name'].href ?? ''));
		}
		console.log('Total notification rows processed:', rows.length);
	}
}

function parseTable(html: string, id: string) {
	const rows: Record<string, { href?: string; text: string }>[] = [];

	// Find the gridItems table
	const tableMatch = html.match(new RegExp(`<table[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/table>`, 'i'));
	if (!tableMatch) {
		throw new Error(`Could not find ${id} table on HTML Modules page`);
	}

	const tableHtml = tableMatch[1];

	const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
	const headerRegex = /<th[^>]*>([\s\S]*?)<\/th>/gi;

	// get column headers from thead row
	const theadMatch = tableHtml.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
	if (!theadMatch) {
		throw new Error(`Could not find thead in ${id} table on HTML Modules page`);
	}

	const theadHtml = theadMatch[1];
	const headers = [];
	let rowMatch = rowRegex.exec(theadHtml);
	if (rowMatch) {
		const rowHtml = rowMatch[1];
		let headerMatch;
		while ((headerMatch = headerRegex.exec(rowHtml)) !== null) {
			const headerText = headerMatch[1].replace(/\s*<span class="sr-only">[\s\S]*?<\/span>/g, '').replace(/<[^>]*>/g, '').trim();
			headers.push(headerText);
		}
	}

	// Extract all rows from tbody
	const tbodyMatch = tableHtml.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
	if (!tbodyMatch) {
		return rows;
	}

	const tbodyHtml = tbodyMatch[1];
	rowRegex.lastIndex = 0;
	while ((rowMatch = rowRegex.exec(tbodyHtml)) !== null) {
		const rowHtml = rowMatch[1];

		// Extract columns (td elements)
		const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
		let cellMatch;

		const row: (typeof rows)[number] = {};
		let headerIndex = 0;
		while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
			let value = cellMatch[1].trim();
			const href = extractHref(value);
			const text = value.replace(/<[^>]*>/g, '').trim();
			row[headers[headerIndex]] = {
				href,
				text,
			};
			headerIndex++;
		}
		rows.push(row);
	}

	return rows;
}

function extractHref(html: string): string | undefined {
	return html.match(/href="([^"]*)"/i)?.[1];
}

async function getTableRows(url: string, tableId: string, newLinkTitle?: string) {
		let pageNumber = 1;
		const maxPages = 100; // Safety limit to prevent infinite loops

		let newLinkUrl = null;
		const allRows = [];
	
		while (pageNumber <= maxPages) {
			let pageUrl = url;
			// Append page parameter if not the first page
			if (pageNumber > 1) {
				pageUrl += `?page=${pageNumber}`;
			}
	
			try {
				const html = await CM.client.get(pageUrl).text();
				// get new link
				if (newLinkTitle) {
					const newLink = extractLinkFromHtmlByTitle(html, newLinkTitle);
					newLinkUrl = newLink ? new URL(newLink, url) : undefined;
				}
				const rows = parseTable(html, tableId);
	
				if (rows.length === 0) {
					// No rows found, stop pagination
					break;
				}
	
				allRows.push(...rows);
	
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
		return allRows;
}


class ClientPortalDirectory<T extends 'Client Portal'> extends AppDirectory<T> {

}



class HTMLModule extends File {
	parent: HTMLModulesDirectory;
	url: string;
	id: string;
	fields: Map<string, string>;
	constructor(name: string, parent: HTMLModulesDirectory, url: string) {
		super(name, parent, url);
		this.parent = parent;
		this.url = new URL(url, parent.url).toString();
		this.fields = new Map<string, string>();
		this.id = url.split('ModID=')[1] || '0';
	}

	async load() {
		const html = await CM.client.get(this.url).text();

		// Extract content from appropriate textarea
		// @todo: don't dupe code with NotificationTemplate
		const contentMatch = html.match(/<textarea[^>]*id="CKEContent_Content"[^>]*>([\s\S]*?)<\/textarea>/i);

		if (!contentMatch) {
			throw new Error(`Could not find HTML content in the fetched page for file: ${this.name}`);
		}
		// @todo: mark read only


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
		this.data = new Uint8Array(contentBuffer);
		this.size = this.data.length;

		this.fields.set('__RequestVerificationToken', getFieldValue(html, '__RequestVerificationToken'));
		this.fields.set('IsForNext', getFieldValue(html, 'IsForNext') || 'False');
		this.fields.set('IsForClient', getFieldValue(html, 'IsForClient') || 'True');
		this.fields.set('ModuleClientPortalApplicationID', getFieldValue(html, 'ModuleClientPortalApplicationID') || '');
		this.fields.set('ClientPortalCategoryName', getSelectValue(html,'ClientPortalCategoryName') || 'TDClient');
		this.fields.set('ShowBorder', getCheckboxValue(html, 'ShowBorder') || 'false');
		this.fields.set('ShowName', getCheckboxValue(html, 'ShowName') || 'false');
		this.fields.set('IsSanitized', 'True');
		this.fields.set('IsSanitized', 'false');
		this.fields.set('CKEContent.EditorKey', getFieldValue(html, 'CKEContent.EditorKey') || '');
		
		this.utime = Date.now();
	}

	async save() {
		if (!this.data) {
			throw new Error(`No data loaded for file: ${this.name}. Please call load() before accessing content.`);
		}
		//		editPageUrl = new URL('HtmlModuleEdit', baseUrlPath).toString();;
		// /TDAdmin/71907D89-441A-48BE-9CD6-A59A2C5EA305/277/DesktopTemplates/DesktopModuleEditSave?moduleID=0
		const saveUrl = new URL('DesktopModuleEditSave', this.url);
		saveUrl.searchParams.append('moduleID', this.id);

		this.fields.set('Name', this.rawName);  // Use the original module name, not the sanitized one
		this.fields.set('CKEContent.Content',  Buffer.from(this.data).toString('utf-8'));

		// Convert Map to URLSearchParams
		const formData = new URLSearchParams();
		for (const [key, value] of this.fields) {
			formData.append(key, value);
		}

		const saveResponse = await CM.client.post(saveUrl, {
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
				'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
				// 'Referer': fullUrl,
				// 'Origin': new URL(session.baseUrl).origin,
				'Sec-Fetch-Dest': 'empty',
				'Sec-Fetch-Mode': 'cors',
				'Sec-Fetch-Site': 'same-origin',
			},
			body: formData.toString(),
		});

		// Accept both successful responses (2xx) and redirects (3xx)
		if (saveResponse.statusCode < 200 || saveResponse.statusCode >= 400) {

			throw new Error(`Failed to save file: ${saveResponse.statusCode} ${saveResponse.statusMessage}`);
		}
		// modID is correct
		const newId = saveResponse.headers.location?.split('?modID=')[1];
		if (!newId) {
			throw new Error(`Failed to extract module ID from save response. Location header: ${saveResponse.headers.location}`);
		}
		this.id = newId;
	}
}

class NotificationTemplate extends File {
	parent: NotificationTemplatesDirectory;
	url: string;
	fields: Map<string, string>;
	constructor(name: string, parent: NotificationTemplatesDirectory, url: string) {
		super(name, parent);
		this.parent = parent;
		this.url = this.url = new URL(url, parent.url).toString();
		this.fields = new Map<string, string>();
	}

	async load() {
		const html = await CM.client.get(this.url).text();

		// Extract content from appropriate textarea
		const contentMatch = html.match(/<textarea[^>]*id="txtTemplate"[^>]*>(?:\r\n)?([\s\S]*?)<\/textarea>/i);

		if (!contentMatch) {
			throw new Error(`Could not find HTML content in the fetched page for file: ${this.name}`);
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
		this.data = new Uint8Array(contentBuffer);
		this.size = this.data.length;
		this.utime = Date.now();

		this.fields.set('txtSubject', getFieldValue(html, 'txtSubject'));
		this.fields.set('txtTemplate', unescaped);
		this.fields.set('smMain', 'smMain|btnSave');
		this.fields.set('__EVENTTARGET', 'btnSave');
		this.fields.set('__EVENTARGUMENT', '');
		this.fields.set('__VIEWSTATE', getFieldValue(html, '__VIEWSTATE'));
		this.fields.set('__VIEWSTATEGENERATOR', getFieldValue(html, '__VIEWSTATEGENERATOR'));
		this.fields.set('__EVENTVALIDATION', getFieldValue(html, '__EVENTVALIDATION'));
		this.fields.set('__ASYNCPOST', 'true');
		
		this.utime = Date.now();
	}

	async save() {
		if (!this.data) {
			throw new Error(`No data loaded for file: ${this.name}. Please call load() before accessing content.`);
		}

		this.fields.set('txtTemplate',  Buffer.from(this.data).toString('utf-8'));

		// Convert Map to URLSearchParams
		const formData = new URLSearchParams();
		for (const [key, value] of this.fields) {
			formData.append(key, value);
		}

		const saveResponse = await CM.client.post(this.url, {
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
				'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
				// 'Referer': fullUrl,
				// 'Origin': new URL(session.baseUrl).origin,
				'Sec-Fetch-Dest': 'empty',
				'Sec-Fetch-Mode': 'cors',
				'Sec-Fetch-Site': 'same-origin',
			},
			body: formData.toString(),
		});

		if (saveResponse.statusCode !== 200) {
			throw new Error(`Failed to save file: ${saveResponse.statusCode} ${saveResponse.statusMessage}`);
		}
	}
}


export type Entry = File | RootDirectory | AppTypeDirectory | AppDirectory;

/**
 * Sanitize filenames by replacing problematic characters with safe alternatives.
 * Slashes are replaced with "／" to preserve readability while avoiding path ambiguity.
 */
function sanitizeFileName(name: string): string {
	return name.replace(/\//g, '／');
}

interface RootAppTableCache {
	html: string;
	lastFetched: number;
}

const appTypes = ['Client Portal', 'Ticketing'] as const;
type AppType = (typeof appTypes)[number];
type Apps = {
	[appType in AppType]: AppDirectory[];
};

export class TdxFS implements vscode.FileSystemProvider {

	root: RootDirectory;

	constructor() {
		this.root = new RootDirectory();
	}

	// --- manage file metadata

	stat(uri: vscode.Uri): vscode.FileStat {
		const result = this._lookup(uri, false);
		return result;
	}

	async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		const entry = this._lookupAsDirectory(uri, false);
		await entry.load();
		
		const result: [string, vscode.FileType][] = [];
		for (const [name, child] of entry.entries) {
			result.push([name, child.type]);
		}
		return result;
	}

	// --- manage file contents

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const file = this._lookupAsFile(uri, false);

		await file.load();
		// this._fireSoon({ type: vscode.FileChangeType.Changed, uri });
		if (file.data) {
			return file.data;
		}
		
		// Return empty buffer for now - VS Code will reload when fetch completes
		return new Uint8Array(0);
	}

	async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean, overwrite: boolean }) {
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
			if (parent instanceof HTMLModulesDirectory) {
				if (!parent.newModuleUrl) {
					throw new Error('Cannot create new HTML Module because the "New" link is not available. Please refresh the directory.');
				}
				const module = new HTMLModule(decodedBasename, parent, parent.newModuleUrl.toString());
				parent.entries.set(decodedBasename, module);
				// get necessary fields
				await module.load();
				entry = module;
			}
			else if (parent instanceof NotificationTemplatesDirectory) {
				const template = new NotificationTemplate(decodedBasename, parent, '0');
				parent.entries.set(decodedBasename, template);
				entry = template;
			}
			else {
				throw new Error(`Cannot create file in directory of type ${parent.constructor.name}`);
			}
			this._fireSoon({ type: vscode.FileChangeType.Created, uri });
		}
		entry.mtime = Date.now();
		entry.size = content.byteLength;
		entry.data = content;
		entry.save();

		this._fireSoon({ type: vscode.FileChangeType.Changed, uri });
	}

	// --- manage files/folders

	rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): void {

		if (!options.overwrite && this._lookup(newUri, true)) {
			throw vscode.FileSystemError.FileExists(newUri);
		}

		const entry = this._lookup(oldUri, false);
		const oldParent = this._lookupParentDirectory(oldUri);

		const newParent = this._lookupParentDirectory(newUri);
		// check if new parent can accept this type of entry
		const newName = decodeURIComponent(newUri.path.split('/').pop() || '');

		// oldParent.entries.delete(entry.name);
		// entry.name = newName;
		// newParent.entries.set(newName, entry);

		// this._fireSoon(
		// 	{ type: vscode.FileChangeType.Deleted, uri: oldUri },
		// 	{ type: vscode.FileChangeType.Created, uri: newUri }
		// );
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

	private _lookupAsDirectory(uri: vscode.Uri, silent: boolean): Directory<File | Directory> {
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

	private _lookupParentDirectory(uri: vscode.Uri): Directory<File | Directory> {
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