export interface RetiredRouteResponseBody {
  code: "endpoint_removed";
  message: string;
  replacement?: string;
}

export interface RetiredRouteResponse {
  status(code: 410): {
    json(body: RetiredRouteResponseBody): unknown;
  };
}

export interface RetiredRouteInput {
  message: string;
  replacement?: string;
}

export function retiredRouteBody(input: RetiredRouteInput): RetiredRouteResponseBody {
  return {
    code: "endpoint_removed",
    message: input.message,
    ...(input.replacement ? { replacement: input.replacement } : {}),
  };
}

export function sendRetiredRoute(
  res: RetiredRouteResponse,
  input: RetiredRouteInput,
): void {
  res.status(410).json(retiredRouteBody(input));
}
