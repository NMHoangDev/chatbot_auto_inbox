# Contributing to zca-js

Thank you for your interest in contributing to zca-js! This project is maintained by the community and we welcome all contributions.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [How to Contribute](#how-to-contribute)
- [Pull Request Process](#pull-request-process)
- [Code Style Guidelines](#code-style-guidelines)
- [Testing Guidelines](#testing-guidelines)
- [Documentation Guidelines](#documentation-guidelines)
- [Security Guidelines](#security-guidelines)
- [Release Process](#release-process)
- [Getting Help](#getting-help)

## Code of Conduct

This project adheres to our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to abide by these rules.

## Getting Started

### Prerequisites

- Node.js >= 18.0.0
- Bun (recommended) or npm
- Git

### Fork and Clone

1. Fork this repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/zca-js.git
   cd zca-js
   ```
3. Add upstream remote:
   ```bash
   git remote add upstream https://github.com/RFS-ADRENO/zca-js.git
   ```

## Development Setup

### Install Dependencies

```bash
# Using Bun (recommended)
bun install

# Or using npm
npm install
```

### Build Project

```bash
# Build both ESM and CJS
bun run build

# Build ESM only
bun run build:esm

# Build CJS only
bun run build:cjs
```

### Run Tests

```bash
# Run feature tests
bun run test:feat

# Run specific test file
bun run test/test.ts
```

### Code Formatting

```bash
# Format code with Prettier
bun run prettier
```

## How to Contribute

### Types of Contributions

We welcome the following types of contributions:

- 🐛 **Bug Reports**: Report bugs and issues
- ✨ **Feature Requests**: Suggest new features
- 🔧 **Code Contributions**: Fix bugs and add features
- 📚 **Documentation**: Improve docs and examples
- 🧪 **Tests**: Add or improve tests
- 🔒 **Security**: Report security vulnerabilities
- 🌐 **Translations**: Translate docs to other languages

### Before You Start

1. **Check existing issues**: Search for existing issues before creating new ones
2. **Discuss major changes**: Create an issue to discuss major changes
3. **Follow the roadmap**: Check the current roadmap and priorities

## Pull Request Process

### Creating a Pull Request

1. **Create a feature branch**:
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```

2. **Make your changes**:
   - Follow code style guidelines
   - Add tests for new functionality
   - Update documentation if needed

3. **Test your changes**:
   ```bash
   bun run build
   bun run test:feat
   ```

4. **Commit your changes**:
   ```bash
   git add .
   git commit -m "feat: add new API method for group management"
   ```

5. **Push to your fork**:
   ```bash
   git push origin feature/your-feature-name
   ```

6. **Create a Pull Request**:
   - Use the provided PR template
   - Link related issues
   - Provide clear description of changes

### PR Review Process

1. **Automated checks** must pass
2. **Code review** by at least one maintainer
3. **Security review** for security-related changes
4. **Documentation review** for API changes
5. **Final approval** before merge

## Code Style Guidelines

### TypeScript Guidelines

- Use TypeScript strict mode
- Prefer interfaces over types for object shapes
- Use meaningful variable and function names
- Add JSDoc comments for public APIs
- Use async/await over Promises when possible

### Code Organization

The project follows a modular structure for better maintainability and organization:

```
zca-js/
├── src/                           # Source code directory
│   ├── apis/                      # API methods (100+ files)
│   │   ├── sendMessage.ts         # Core messaging functionality
│   │   ├── login.ts               # Authentication methods
│   │   ├── loginQR.ts             # QR code login
│   │   ├── listen.ts              # Event listening
│   │   ├── sendVideo.ts           # Video sending
│   │   ├── sendVoice.ts           # Voice sending
│   │   ├── sendSticker.ts         # Sticker sending
│   │   ├── createGroup.ts         # Group management
│   │   ├── addReaction.ts         # Message reactions
│   │   ├── uploadAttachment.ts    # File uploads
│   │   └── ...                    # 90+ other API methods
│   ├── models/                    # TypeScript interfaces and types
│   │   ├── Message.ts             # Message interface
│   │   ├── Attachment.ts          # File attachment types
│   │   ├── Reaction.ts            # Reaction types
│   │   ├── FriendEvent.ts         # Friend event types
│   │   ├── GroupEvent.ts          # Group event types
│   │   ├── Typing.ts              # Typing indicators
│   │   ├── SeenMessage.ts         # Message seen events
│   │   ├── DeliveredMessage.ts    # Message delivery events
│   │   ├── Undo.ts                # Undo functionality
│   │   ├── Enum.ts                # Enumerations
│   │   └── index.ts               # Model exports
│   ├── Errors/                    # Error handling
│   │   ├── ZaloApiError.ts        # Custom API error class
│   │   └── index.ts               # Error exports
│   ├── context.ts                 # Context management and state
│   ├── utils.ts                   # Utility functions and helpers
│   ├── zalo.ts                    # Main Zalo class implementation
│   ├── update.ts                  # Update checking functionality
│   └── index.ts                   # Public API exports
├── examples/                      # Usage examples
│   └── echobot.ts                 # Echo bot example
├── test/                          # Test files
│   ├── feat.ts                    # Feature tests
│   ├── feat.test.ts               # Feature test suite
│   ├── test.ts                    # General tests
│   └── a.png                      # Test assets
├── .github/                       # GitHub configuration
│   └── ISSUE_TEMPLATE/            # Issue templates
├── .dev/                          # Development tools (developer generated)
├── dist/                          # Build output (generated)
├── node_modules/                  # Dependencies (generated)
├── package.json                   # Project configuration
├── tsconfig.json                  # TypeScript configuration
├── rollup.config.js               # Build configuration
├── README.md                      # Project documentation
├── CONTRIBUTING.md                # Contribution guidelines
├── SECURITY.md                    # Security policy
├── CODE_OF_CONDUCT.md             # Community guidelines
└── LICENSE                        # MIT License
```

### Key Directories Explained

- **`src/apis/`**: Contains all API method implementations (~100 files)

- **`src/models/`**: TypeScript interfaces and type definitions
  - Core data structures for messages, events, and API responses
  - Ensures type safety across the application

- **`src/Errors/`**: Custom error handling
  - `ZaloApiError.ts`: Handles API-specific errors
  - Provides consistent error handling across the library

- **`examples/`**: Usage examples and demonstrations
  - `echobot.ts`: Complete example of a Zalo bot implementation

- **`test/`**: Test suites and test assets
  - Feature tests for core functionality
  - Integration tests for API methods

### Naming Conventions

- **Files**: camelCase (e.g., `sendMessage.ts`)
- **Classes**: PascalCase (e.g., `ZaloApiError`)
- **Functions**: camelCase (e.g., `sendMessage`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `API_BASE_URL`)
- **Interfaces**: PascalCase with `I` prefix (e.g., `IMessage`)

### Error Handling

```typescript
// Good
try {
  const result = await api.sendMessage(message);
  return result;
} catch (error) {
  if (error instanceof ZaloApiError) {
      throw error;
  }
  throw new ZaloApiError(`Failed to send message: ${error.message}`);
}

// Bad
try {
  const result = await api.sendMessage(message);
  return result;
} catch (error) {
  console.error(error);
  return null;
}
```

## Testing Guidelines

### Test Structure

```typescript
describe('API Method', () => {
  beforeEach(() => {
    // Setup
  });

  afterEach(() => {
    // Cleanup
  });

  it('should handle success case', async () => {
    // Test implementation
  });

  it('should handle error case', async () => {
    // Test error handling
  });
});
```

### Testing Best Practices

- Test both success and failure scenarios
- Mock external dependencies
- Use descriptive test names
- Keep tests independent
- Test edge cases and error conditions

### Running Tests

```bash
# Run all tests
bun run test:feat

# Run specific test
bun run test/test.ts

# Run with coverage (if available)
bun run test:coverage
```

## Documentation Guidelines

### API Documentation

- Document all public methods with JSDoc
- Include parameter types and descriptions
- Provide usage examples
- Document error conditions

```typescript
/**
 * Sends a message to a specific thread
 * @param message - The message object containing content and metadata
 * @param threadId - The ID of the thread to send the message to
 * @param threadType - The type of thread (User or Group)
 * @returns Promise<Message> - The sent message object
 * @throws {ZaloApiError} When the API request fails
 * @example
 * ```typescript
 * const message = await api.sendMessage(
 *   { msg: "Hello, world!" },
 *   "123456789",
 *   ThreadType.User
 * );
 * ```
 */
async sendMessage(message: IMessage, threadId: string, threadType: ThreadType): Promise<Message>
```

### README Updates

- Update README.md for new features
- Add examples for new APIs
- Update installation instructions if needed
- Keep the table of contents updated

## Security Guidelines

### Security Best Practices

- Never commit sensitive data (tokens, passwords, etc.)
- Use environment variables for configuration
- Validate all user inputs
- Follow the principle of least privilege
- Report security issues privately

### Security Reporting

If you discover a security vulnerability:

1. **DO NOT** create a public issue
2. Use the [SECURITY.md](SECURITY.md) reporting process
3. Create a private issue with `[SECURITY]` label
4. Contact team members directly for urgent issues

### Code Security

```typescript
// Good - Validate inputs
function sendMessage(content: string, threadId: string) {
  if (!content || typeof content !== 'string') {
    throw new ZaloApiError('Content must be a non-empty string');
  }
  if (!threadId || typeof threadId !== 'string') {
    throw new ZaloApiError('ThreadId must be a non-empty string');
  }
  // Implementation
}

// Bad - No validation
function sendMessage(content: any, threadId: any) {
  // Implementation without validation
}
```

## Release Process

### Versioning

We follow [Semantic Versioning](https://semver.org/):

- **MAJOR**: Breaking changes
- **MINOR**: New features (backward compatible)
- **PATCH**: Bug fixes (backward compatible)

### Release Checklist

- [ ] All tests pass
- [ ] Documentation is updated
- [ ] Version is bumped in package.json
- [ ] Build is successful
- [ ] Release notes are prepared

### Publishing

```bash
# Build the project
bun run build

# Run tests
bun run test:feat

# Publish to npm
npm publish
```

## Getting Help

### Communication Channels

- **GitHub Issues**: For bug reports and feature requests
- **GitHub Discussions**: For questions and general discussion
- **Pull Requests**: For code contributions
- **Security Issues**: Use `[SECURITY]` label

### Team Members

- [@RFS-ADRENO](https://github.com/RFS-ADRENO)
- [@truong9c2208](https://github.com/truong9c2208)
- [@JustKemForFun](https://github.com/JustKemForFun)

### Resources

- [API Documentation](https://zca-js.tdung.com)
- [Examples](examples/)
- [Security Policy](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

## Special Considerations for zca-js

### Unofficial API Library

> [!IMPORTANT]
> ⚠️ zca-js is an unofficial API library for Zalo. Please be aware of:

- **Account Risk**: Using this API may result in account suspension
- **Terms of Service**: Respect Zalo's ToS in your contributions
- **Rate Limiting**: Be mindful of API usage limits
- **Privacy**: Protect user privacy and data

### Responsible Development

- Test changes thoroughly before submitting
- Avoid introducing features that could harm users
- Consider the impact on Zalo's infrastructure
- Document any risks or limitations

---

**Thank you for contributing to zca-js!** 🚀

Your contributions help make this library better for the entire community.
