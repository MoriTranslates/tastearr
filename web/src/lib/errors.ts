/** The text to show for anything a promise rejected with (an ApiError carries the server's own message). */
export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
