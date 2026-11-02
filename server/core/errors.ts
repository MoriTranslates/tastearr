/** An error meant for the user, with the HTTP status the API answers it with (the error handler reads statusCode). */
export class AppError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}

/** Use `throw fail("message", 404)` for anything the user caused: 400 bad input, 404 not found, 409 conflict. */
export const fail = (message: string, statusCode = 400) => new AppError(message, statusCode);

/**
 * Runs `call` and turns a plain Error from it into a user-facing one with `statusCode`, for service functions that
 * only throw for user mistakes. Errors that already carry a status are passed on unchanged.
 */
export async function userFacing<T>(call: () => Promise<T> | T, statusCode = 400): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof AppError || (e as { statusCode?: number }).statusCode) throw e;
    throw fail(e instanceof Error ? e.message : String(e), statusCode);
  }
}

/** A positive integer id from a path, query or body. */
export const parseId = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw fail("Bad id");
  return n;
};
