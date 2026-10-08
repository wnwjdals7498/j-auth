import type { AuthApiErrorCode } from '@j-auth/contracts';

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: AuthApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const unavailable = () =>
  new ApiError(503, 'unavailable', 'Service temporarily unavailable.');
export const unauthenticated = () =>
  new ApiError(401, 'unauthenticated', 'Authentication required.');
export const forbidden = () =>
  new ApiError(403, 'forbidden', 'Permission denied.');
