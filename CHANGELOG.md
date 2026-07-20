# Change Log

All notable changes to the "tdx-fs" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [1.0.0] - 2026-07-20

### Added
- **Playwright-based SSO Authentication**: Secure login to TeamDynamix via persistent Edge browser context
- **Virtual File System**: Browse TeamDynamix HTML Modules through the `tdx://` URI scheme in VS Code Explorer
- **Module Discovery**: Automatic discovery and listing of all available HTML Modules with pagination support
- **File Reading**: Fetch and display HTML module content in VS Code editor with automatic HTML entity unescaping
- **File Editing**: Edit HTML module content directly in VS Code with live preview support
- **File Saving**: Post modified HTML content back to TeamDynamix with automatic form field extraction and CSRF token handling
- **Session Persistence**: Encrypted credential storage using VS Code Secrets API with automatic session restoration on startup
- **Cookie Management**: Automatic Set-Cookie header capture and jar management via tough-cookie for reliable session handling
- **Security**: Proper HTTP security headers (Sec-Fetch-*, Referer, Origin) and verification token handling for CSRF protection