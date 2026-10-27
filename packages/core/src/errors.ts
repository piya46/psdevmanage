export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function ensure(
  value: unknown,
  status: number,
  code: string,
  message: string,
): asserts value {
  if (!value) throw new AppError(status, code, message);
}
