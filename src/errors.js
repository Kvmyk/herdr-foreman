// Errors with a stable code the CLI and the leader can act on.
export function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}
