/** Match the API's hyphenated UUID syntax without accepting alternate forms. */
export function normalizeUuid(value: string, field: string): string {
  if (typeof value !== "string" || value.length !== 36 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}
