import { HttpException, HttpStatus } from "@nestjs/common";
export class ApiError extends HttpException {
  constructor(
    code: string,
    status = HttpStatus.BAD_REQUEST,
    message = code,
    details?: Record<string, unknown>,
  ) {
    super({ code, message, ...(details ? { details } : {}) }, status);
  }
}
