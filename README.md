# TeamDynamix HTML Modules File System

A VS Code extension that provides a virtual file system interface for browsing, editing, and managing TeamDynamix HTML Modules directly from your editor.

## Features

- **Seamless Authentication**: Automatic Microsoft SSO login with persistent session management
- **Virtual File System**: Access TeamDynamix HTML Modules via the `tdx://` URI scheme
- **Browse Modules**: Explore all available HTML Modules in VS Code's File Explorer
- **Edit & Save**: Modify module content in VS Code and save changes directly to TeamDynamix
- **Automatic Session Recovery**: Sessions are encrypted and restored automatically on restart
- **Smart Cookie Management**: Proper handling of authentication cookies across all requests

## Requirements

- **Visual Studio Code** 1.125.0 or later
- **TeamDynamix Instance** with HTML Modules feature enabled
- **Microsoft Account** for SSO authentication
- **Network Access** to your TeamDynamix instance

## Installation & Setup

1. Install the extension from VS Code Extensions marketplace
2. Open VS Code and run the command `TeamDynamix: Initialize Session`
3. When prompted, enter your TeamDynamix base URL (e.g., `https://your-domain.teamdynamix.com`)
4. Complete the Microsoft sign-in in the Edge browser window that opens
5. The extension will automatically discover your HTML Modules and display them in Explorer

Your session credentials are securely stored in VS Code's credential storage and will be restored automatically when you restart.

## Extension Commands

This extension contributes the following commands:

- **`TeamDynamix: Initialize Session`** - Authenticate with your TeamDynamix instance and load HTML Modules
- **`TeamDynamix: Clear Session`** - Clear stored credentials and sign out

## How It Works

1. **Authentication**: Uses Playwright to automate Microsoft SSO login, extracting session cookies from the browser context
2. **Module Discovery**: Navigates TeamDynamix UI to find and list all available HTML Modules
3. **Virtual File System**: Provides a `tdx://` URI scheme handler that acts as a file system proxy
4. **Content Handling**: Fetches module HTML, unescapes entities, and caches content in memory
5. **Saving Changes**: When you save a file, the extension extracts form fields and posts the modified content back to TeamDynamix
6. **Session Management**: Maintains a cookie jar that automatically captures and updates authentication cookies across requests

## Known Limitations

- Requires interactive browser-based authentication with Microsoft SSO
- HTML Modules must be accessible through the standard TeamDynamix UI
- Large module content is loaded on-demand to avoid memory bloat
- Session expiration will require re-authentication via the Initialize Session command

## Contributing

Found a bug or have a feature request? Please open an issue on the repository.

## License

MIT
