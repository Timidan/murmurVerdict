export interface CacheablePublicResource {
  body: unknown;
  cacheControl: string;
  contentType: string;
  etag?: string;
  accessControlAllowOrigin?: string;
  bodyMode?: "raw" | "json";
}

export interface CacheablePublicResourceRequest {
  header(name: string): string | undefined;
}

export interface CacheablePublicResourceResponse {
  status(code: number): CacheablePublicResourceResponse;
  setHeader(name: string, value: string): unknown;
  send(body: unknown): unknown;
  json(body: unknown): unknown;
  end(): unknown;
}

export type CacheablePublicResourceResult = "sent" | "not_modified";

export function sendCacheablePublicResource(
  req: CacheablePublicResourceRequest,
  res: CacheablePublicResourceResponse,
  resource: CacheablePublicResource,
): CacheablePublicResourceResult {
  if (resource.etag && req.header("If-None-Match") === resource.etag) {
    res.status(304).end();
    return "not_modified";
  }
  res.setHeader("Content-Type", resource.contentType);
  res.setHeader("Cache-Control", resource.cacheControl);
  if (resource.accessControlAllowOrigin) {
    res.setHeader("Access-Control-Allow-Origin", resource.accessControlAllowOrigin);
  }
  if (resource.etag) res.setHeader("ETag", resource.etag);
  if (resource.bodyMode === "json") {
    res.json(resource.body);
    return "sent";
  }
  res.send(resource.body);
  return "sent";
}
