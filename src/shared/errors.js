// The error every model client throws. `code` is stable and maps to a
// localized message (error_<code>, or error_<provider>_<code> where the
// provider needs its own words; see i18n.js errorMessage).

export class ApiError extends Error {
  /** @param {string} code  stable code mapped to a localized message */
  constructor(code, detail = '', status = 0) {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}
