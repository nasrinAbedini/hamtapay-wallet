import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import { Response } from "express";
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const payload =
      error instanceof HttpException
        ? error.getResponse()
        : { code: "INTERNAL_ERROR", message: "Internal server error" };
    response
      .status(status)
      .json(
        typeof payload === "string"
          ? { code: "ERROR", message: payload }
          : payload,
      );
  }
}
