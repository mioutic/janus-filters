// Exit codes and the error type every stage throws. PIPELINE section 3.

export const EXIT = {
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  POLICY: 3,
  NETWORK: 4,
  INTEGRITY: 5,
};

export class PipelineError extends Error {
  /**
   * @param {number} code one of EXIT
   * @param {string} message no environment values, no secrets
   * @param {object} [details] machine-readable context, logged as JSON
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PipelineError";
    this.code = code;
    this.details = details;
  }
}

export const usageError = (message, details) => new PipelineError(EXIT.USAGE, message, details);
export const policyError = (message, details) => new PipelineError(EXIT.POLICY, message, details);
export const networkError = (message, details) => new PipelineError(EXIT.NETWORK, message, details);
export const integrityError = (message, details) =>
  new PipelineError(EXIT.INTEGRITY, message, details);
