// Named for its first caller. Every AI feature throws it, and the error handler in
// index.js turns any of them into { error, hint } with the right status.
export class ExplainError extends Error {
  constructor(message, status = 502, hint = '') {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}
