/** An error meant for the user, with the HTTP status the API answers it with (the error handler reads statusCode). */
export class AppError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}

export const fail = (message: string, statusCode = 400) => new AppError(message, statusCode);

/** A positive integer id from a path, query or body. */
export const parseId = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw fail("Bad id");
  return n;
};
