export const DIRECT_CORS_GUIDANCE = "The provider could not be reached directly. If its API blocks browser CORS, connect the companion extension and explicitly switch transport to Extension.";

export const directCorsAwareFetch: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (error instanceof TypeError) throw new Error(DIRECT_CORS_GUIDANCE, { cause: error });
    throw error;
  }
};

export function isDirectCorsGuidanceError(error: unknown): error is Error {
  return error instanceof Error && error.message === DIRECT_CORS_GUIDANCE;
}
