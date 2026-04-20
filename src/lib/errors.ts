// Typed errors with PRD §7.2 exit codes. Each subclass maps to a specific code.

export class FerretError extends Error {
  readonly exitCode: number = 1;
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ConfigError extends FerretError {
  override readonly exitCode = 2;
}

export class AuthError extends FerretError {
  override readonly exitCode = 3;
}

// Signals that the user explicitly cancelled an OAuth flow in the browser
// (e.g. hit "Cancel" or closed the consent screen). Renders without a stack
// dump and inherits AuthError's exit code 3 since auth didn't complete.
export class OAuthCancelledError extends AuthError {}

export class NetworkError extends FerretError {
  override readonly exitCode = 4;
}

export class RateLimitError extends FerretError {
  override readonly exitCode = 5;
}

export class ValidationError extends FerretError {
  override readonly exitCode = 6;
}

export class DataIntegrityError extends FerretError {
  override readonly exitCode = 7;
}

// Used by stub commands. Prints a clear "not implemented" message and exits 1.
export function notImplemented(name: string, issueNumber: number): never {
  process.stderr.write(`ferret ${name}: not implemented yet — see issue #${issueNumber}\n`);
  process.exit(1);
}
